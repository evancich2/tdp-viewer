// The Bambu LAN bridge (tools/printer.ts, tools/bambu/*) against byte-level vectors and a
// SIMULATED H2C (tests/helpers/fake-h2c.ts). This shows the bridge speaks the community-documented
// protocol correctly and fails safely; it doesn't show the real printer answers this way.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { RecordData } from "../src/core/records";
import { control, pinPrinter, readFirmware, remoteNameFor, startPrint, suitabilityResource, uploadFile, listFiles, watch, withPrinter } from "../tools/bambu/commands";
import { parseAnnouncement } from "../tools/bambu/discover";
import { FtpsClient, checkRemoteName } from "../tools/bambu/ftps";
import { AUTH_REFUSED, BambuPrinter, PrinterFile, amsMapping2, buildMapping, explainRefusal, hmsCode, mergeReport, projectFileCommand, replyTo, summarize } from "../tools/bambu/h2c";
import { MAX_PACKET, PacketReader, decodePublish, encodeConnect, encodeLength, encodePublish, encodeSubscribe } from "../tools/bambu/mqtt";
import { PinMismatch, normalizeFingerprint } from "../tools/bambu/pinned";
import { SlicedFileError, inspectSliced } from "../tools/bambu/sliced";
import { OPENSSL, makeCert, startFakeH2C, type FakeH2C, type FakeOptions } from "./helpers/fake-h2c";

const SERIAL = "0948AB123400042";
const CODE = "12345678";
const enc = (s: string) => new TextEncoder().encode(s);
const md5 = (b: Uint8Array | string) => createHash("md5").update(b).digest("hex");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** A minimal sliced Bambu Studio project. */
function sliced(o: { plates?: number[]; filaments?: { id: number; type: string; color: string }[]; projectFilaments?: number; md5?: string | false; extra?: Record<string, Uint8Array> } = {}): Uint8Array {
  const plates = o.plates ?? [1];
  const fil = o.filaments ?? [{ id: 1, type: "PETG", color: "#FFFFFF" }];
  const files: Record<string, Uint8Array> = { "3D/3dmodel.model": enc("<model/>"), ...o.extra };
  for (const p of plates) {
    const g = `; plate ${p}\nG28\nG1 X10 Y10 F3000\n`;
    files[`Metadata/plate_${p}.gcode`] = enc(g);
    if (o.md5 !== false) files[`Metadata/plate_${p}.gcode.md5`] = enc((o.md5 ?? md5(g)).toUpperCase());
  }
  files["Metadata/slice_info.config"] = enc(`<?xml version="1.0"?><config>${plates.map((p) => `<plate><metadata key="index" value="${p}"/><metadata key="printer_model_id" value="O1C"/><metadata key="nozzle_diameters" value="0.4"/><metadata key="prediction" value="1800"/><metadata key="weight" value="12.5"/>${fil.map((f) => `<filament id="${f.id}" type="${f.type}" color="${f.color}" used_m="1.2" used_g="${f.id * 3}"/>`).join("")}</plate>`).join("")}</config>`);
  files["Metadata/project_settings.config"] = enc(JSON.stringify({ filament_colour: Array.from({ length: o.projectFilaments ?? fil.length }, () => "#FFFFFF") }));
  return zipSync(files);
}

describe("MQTT codec (byte vectors from the 3.1.1 spec)", () => {
  it("encodes remaining lengths", () => {
    const hex = (n: number) => encodeLength(n).toString("hex");
    expect([0, 127, 128, 16383, 16384, 2097151, 2097152, 268435455].map(hex)).toEqual(["00", "7f", "8001", "ff7f", "808001", "ffff7f", "80808001", "ffffff7f"]);
    expect(() => encodeLength(268435456)).toThrow();
    expect(() => encodeLength(-1)).toThrow();
  });

  it("encodes CONNECT with user name and password", () => {
    const b = encodeConnect({ clientId: "c", username: "bblp", password: "12345678", keepalive: 60 });
    expect(b.toString("hex")).toBe("101d" + "00044d515454" + "04" + "c2" + "003c" + "000163" + "000462626c70" + "00083132333435363738");
  });

  it("encodes SUBSCRIBE and PUBLISH (QoS 0 and 1)", () => {
    expect(encodeSubscribe(1, "a/b").toString("hex")).toBe("8208" + "0001" + "0003612f62" + "00");
    expect(encodePublish("t", Buffer.from("hi")).toString("hex")).toBe("3005" + "000174" + "6869");
    expect(encodePublish("t", Buffer.from("hi"), 1, 10).toString("hex")).toBe("3207" + "000174" + "000a" + "6869");
  });

  it("reassembles packets split across chunks and splits packets sharing a chunk", () => {
    const big = encodePublish("device/x/report", Buffer.alloc(70_000, 0x41));
    const two = Buffer.concat([big, encodePublish("t", Buffer.from("z"), 1, 7)]);
    const r = new PacketReader();
    const got = [];
    for (let i = 0; i < two.length; i += 997) got.push(...r.push(two.subarray(i, i + 997)));
    expect(got).toHaveLength(2);
    const a = decodePublish(got[0]!), b = decodePublish(got[1]!);
    expect([a.topic, a.payload.length, a.qos]).toEqual(["device/x/report", 70_000, 0]);
    expect([b.topic, b.payload.toString(), b.qos, b.id]).toEqual(["t", "z", 1, 7]);
    const one = new PacketReader();
    const bytes = encodePublish("t", Buffer.from("x"));
    const seen = [...bytes].flatMap((x) => one.push(Buffer.from([x])));
    expect(seen).toHaveLength(1);
  });

  it("refuses oversized and malformed packets", () => {
    expect(() => new PacketReader().push(Buffer.concat([Buffer.from([0x30]), encodeLength(MAX_PACKET + 1)]))).toThrow(/exceeds/);
    expect(() => new PacketReader().push(Buffer.from([0x30, 0xff, 0xff, 0xff, 0xff, 0x01]))).toThrow(/malformed/);
    expect(() => decodePublish({ type: 3, flags: 0, body: Buffer.from([0, 9, 1]) })).toThrow(/short/);
  });
});

describe("certificate pins", () => {
  it("normalizes fingerprints and rejects anything that isn't SHA-256", () => {
    const hex = "ab".repeat(32);
    expect(normalizeFingerprint(hex)).toBe(Array(32).fill("AB").join(":"));
    expect(normalizeFingerprint(Array(32).fill("ab").join(":"))).toBe(normalizeFingerprint(hex));
    expect(() => normalizeFingerprint("ab".repeat(20))).toThrow(/SHA-256/);
  });
});

describe("sliced file inspection", () => {
  it("reads plates, G-code MD5, filaments and the project's filament count", () => {
    const bytes = sliced({ filaments: [{ id: 2, type: "PETG", color: "#000000" }], projectFilaments: 3 });
    const p = inspectSliced(bytes);
    expect(p.plates).toEqual([1]);
    expect(p.projectFilaments).toBe(3);
    expect(p.sha256).toBe(sha256(bytes));
    expect(p.plate.gcodeMd5).toBe(md5("; plate 1\nG28\nG1 X10 Y10 F3000\n"));
    expect(p.plate.declaredMd5).toBe(p.plate.gcodeMd5);
    expect(p.plate).toMatchObject({ gcodePath: "Metadata/plate_1.gcode", printerModelId: "O1C", predictionSeconds: 1800, weightGrams: 12.5, filaments: [{ id: 2, type: "PETG", color: "#000000", usedGrams: 6 }] });
  });

  it("refuses unsliced 3MFs, damaged G-code and ambiguous plates", () => {
    expect(() => inspectSliced(zipSync({ "3D/3dmodel.model": enc("<model/>") }))).toThrow(/no sliced plate/);
    expect(() => inspectSliced(sliced({ md5: "0".repeat(32) }))).toThrow(/doesn't match the MD5/);
    expect(() => inspectSliced(sliced({ plates: [1, 3] }))).toThrow(/plates 1, 3; choose one/);
    expect(inspectSliced(sliced({ plates: [1, 3] }), 3).plate.gcodePath).toBe("Metadata/plate_3.gcode");
    expect(() => inspectSliced(sliced({ plates: [1, 3] }), 2)).toThrow(/plate 2 has no G-code/);
    expect(() => inspectSliced(enc("not a zip at all"))).toThrow(SlicedFileError);
    expect(inspectSliced(sliced({ md5: false })).plate.declaredMd5).toBeUndefined();
  });
});

describe("H2C message handling", () => {
  it("merges incremental reports without prototype pollution", () => {
    const s: Record<string, unknown> = {};
    mergeReport(s, { gcode_state: "RUNNING", mc_percent: 1, nested: { a: 1, b: 2 } });
    mergeReport(s, JSON.parse('{"mc_percent": 5, "nested": {"b": 3}, "__proto__": {"polluted": true}}'));
    expect(s).toEqual({ gcode_state: "RUNNING", mc_percent: 5, nested: { a: 1, b: 3 } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("formats HMS codes and summarizes a report", () => {
    expect(hmsCode({ attr: 0x05000500, code: 0x00010007 })).toBe("0500-0500-0001-0007");
    const s = summarize({ gcode_state: "RUNNING", mc_percent: 42, layer_num: 10, total_layer_num: 80, subtask_name: "latch", nozzle_temper: 250.5, bed_temper: "70", print_error: 0, hms: [{ attr: 0x0300_0300, code: 0x0001_0004 }, "junk"] });
    expect(s).toMatchObject({ state: "RUNNING", percent: 42, layer: "10/80", file: "latch", nozzleTemp: 250.5, bedTemp: 70, hms: ["0300-0300-0001-0004"] });
    expect(s.printError).toBeUndefined();
    expect(summarize({}).state).toBe("UNKNOWN");
    expect(summarize({ task_id: 123 }).taskId).toBe("123");
  });

  it("recognizes replies and explains refusals", () => {
    const ok = replyTo("print", "project_file", "7", { print: { command: "project_file", sequence_id: 7, result: "success" } });
    expect(ok?.accepted).toBe(true);
    expect(replyTo("print", "project_file", "8", { print: { command: "project_file", sequence_id: "7" } })).toBeUndefined();
    expect(replyTo("print", "pause", "7", { print: { command: "project_file", sequence_id: "7" } })).toBeUndefined();
    const no = replyTo("print", "stop", "1", { print: { command: "stop", sequence_id: "1", result: "SUCCESS", err_code: 0x05024009 } })!;
    expect(no.accepted).toBe(false);
    expect(AUTH_REFUSED(no.errCode)).toBe(true);
    expect(explainRefusal(no)).toMatch(/Developer Mode/);
    expect(replyTo("print", "stop", "1", { print: { command: "stop", sequence_id: "1", result: "fail" } })!.accepted).toBe(false);
    expect(explainRefusal({ accepted: false, errCode: 0x0500400e, reason: "md5 mismatch", raw: {} })).not.toMatch(/Developer Mode/);
  });

  it("maps filaments to AMS trays or an external spool", () => {
    const p = inspectSliced(sliced({ filaments: [{ id: 1, type: "PETG", color: "#fff" }, { id: 3, type: "PLA", color: "#000" }], projectFilaments: 4 }));
    expect(buildMapping(p, { kind: "ams", trays: [0, -1, 5] })).toEqual([0, -1, 5, -1]);
    expect(() => buildMapping(p, { kind: "ams", trays: [0] })).toThrow(/filament 3 .* no AMS tray/);
    expect(() => buildMapping(p, { kind: "ams", trays: [0, 1, 2, 3, 4] })).toThrow(/4 filaments/);
    expect(() => buildMapping(p, { kind: "ams", trays: [0, -1, 99] })).toThrow(/bad AMS tray 99/);
    expect(() => buildMapping(p, { kind: "ams", trays: [0, -1, 254] })).toThrow(/--spool/);
    expect(() => buildMapping(p, { kind: "spool", side: "left" })).toThrow(/only one/);
    const one = inspectSliced(sliced({ filaments: [{ id: 2, type: "PETG", color: "#fff" }], projectFilaments: 2 }));
    expect(buildMapping(one, { kind: "spool", side: "left" })).toEqual([-1, 254]);
    expect(buildMapping(one, { kind: "spool", side: "right" })).toEqual([-1, 255]);
    expect([0, 3, 4, 13, 128, 254, 255, -1].map(amsMapping2)).toEqual([
      { ams_id: 0, slot_id: 0 }, { ams_id: 0, slot_id: 3 }, { ams_id: 1, slot_id: 0 }, { ams_id: 3, slot_id: 1 },
      { ams_id: 128, slot_id: 0 }, { ams_id: 254, slot_id: 0 }, { ams_id: 255, slot_id: 0 }, { ams_id: 255, slot_id: 255 },
    ]);
  });

  it("builds the H2-series project_file command", () => {
    const project = inspectSliced(sliced());
    const c = projectFileCommand({ remoteName: "latch_A.gcode.3mf", project, mapping: [2], useAms: true, taskId: "123", bedLeveling: true, flowCalibration: false, vibrationCalibration: false, layerInspect: true, timelapse: false, bedType: "auto" }, "55").print as Record<string, unknown>;
    expect(c).toMatchObject({ command: "project_file", sequence_id: "55", param: "Metadata/plate_1.gcode", url: "ftp:///latch_A.gcode.3mf", file: "latch_A.gcode.3mf", md5: project.plate.gcodeMd5, subtask_name: "latch_A", task_id: "123", project_id: "123", subtask_id: "123", bed_leveling: 1, layer_inspect: 1, timelapse: 0, use_ams: true, ams_mapping: [2], ams_mapping2: [{ ams_id: 0, slot_id: 2 }] });
  });

  it("makes safe remote names and refuses unsafe ones", () => {
    expect(remoteNameFor("/tmp/SYN PH-2001 (rev A).gcode.3mf")).toBe("SYN_PH-2001_rev_A_.gcode.3mf");
    expect(remoteNameFor("C:\\jobs\\latch.3mf")).toBe("latch.gcode.3mf");
    expect(remoteNameFor("..gcode.3mf")).toBe("part.gcode.3mf");
    for (const bad of ["../x.3mf", "a/b.3mf", "x\r\nDELE y", "", ".hidden"]) expect(() => checkRemoteName(bad)).toThrow(/unsafe/);
  });
});

describe("discovery", () => {
  const notify = (loc: string) => `NOTIFY * HTTP/1.1\r\nHOST: 239.255.255.250:1990\r\nServer: Buildroot/2018.02-rc3 UPnP/1.0 ssdpd/1.8\r\nLocation: ${loc}\r\nNT: urn:bambulab-com:device:3dprinter:1\r\nUSN: ${SERIAL}\r\nCache-Control: max-age=1800\r\nDevModel.bambu.com: O1C\r\nDevName.bambu.com: Lab H2C\r\nDevSignal.bambu.com: -45\r\nDevConnect.bambu.com: lan\r\nDevBind.bambu.com: free\r\n\r\n`;
  it("parses printer announcements and trusts the source address", () => {
    expect(parseAnnouncement(notify("192.168.4.20"), "192.168.4.20")).toMatchObject({ host: "192.168.4.20", serial: SERIAL, model: "O1C", name: "Lab H2C", connect: "lan", bind: "free", claimedHost: undefined });
    expect(parseAnnouncement(notify("10.0.0.1"), "192.168.4.20")).toMatchObject({ host: "192.168.4.20", claimedHost: "10.0.0.1" });
    expect(parseAnnouncement("NOTIFY * HTTP/1.1\r\nNT: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: tv\r\n\r\n", "192.168.4.9")).toBeUndefined();
    expect(parseAnnouncement("garbage", "1.2.3.4")).toBeUndefined();
  });
});

// ---- against the simulated printer ----

const live = OPENSSL ? describe : describe.skip;
live("against a simulated H2C", () => {
  let fake: FakeH2C | undefined;
  afterEach(async () => { await fake?.close(); fake = undefined; });

  const start = async (o: Partial<FakeOptions> = {}) => (fake = await startFakeH2C({ serial: SERIAL, accessCode: CODE, devMode: true, stepMs: 20, ...o }));
  const pinned = async (f: FakeH2C) => (await pinPrinter({ host: "127.0.0.1", resourceId: "H2C-LAB-01", mqttPort: f.mqttPort, ftpsPort: f.ftpsPort, now: new Date("2026-11-13T12:00:00Z") })).file;

  it("pins both certificates and takes the serial from the certificate", async () => {
    const f = await start();
    const r = await pinPrinter({ host: "127.0.0.1", resourceId: "H2C-LAB-01", mqttPort: f.mqttPort, ftpsPort: f.ftpsPort });
    expect(r.file).toMatchObject({ schema: "tdp-printer/0.1", serial: SERIAL, model: "Bambu Lab H2C", mqttFingerprint: f.fingerprint, ftpsFingerprint: f.fingerprint });
    expect(PrinterFile.parse(JSON.parse(JSON.stringify(r.file)))).toEqual(r.file);
    expect(f.connects).toHaveLength(0); // pinning sends no credentials
    expect(JSON.stringify(r.file)).not.toContain(CODE);
  });

  it("pins MQTT alone when FTPS is closed, and says why", async () => {
    const f = await start();
    const r = await pinPrinter({ host: "127.0.0.1", resourceId: "H2C-LAB-01", mqttPort: f.mqttPort, ftpsPort: 1 });
    expect(r.file.ftpsFingerprint).toBeUndefined();
    expect(r.ftpsError).toMatch(/127\.0\.0\.1:1/);
    await expect(listFiles(r.file, CODE)).rejects.toThrow(/no FTPS certificate pin/);
  });

  it("reads status and firmware, and checks the firmware against the H2C profile", async () => {
    const f = await start();
    const cfg = await pinned(f);
    await withPrinter(cfg, CODE, async (p) => {
      const s = await p.refresh();
      expect(s).toMatchObject({ state: "IDLE", nozzleTemp: 25, bedTemp: 24, chamberTemp: 26, hms: [] });
      const fw = await readFirmware(p);
      expect(fw).toMatchObject({ firmware: "01.03.00.00", profileFirmware: "01.03.00.00", matches: true });
      expect(fw.modules.map((m) => m.name)).toEqual(["ota", "mc", "ams/0"]);
      expect(suitabilityResource(cfg, fw.firmware)).toEqual({ id: "H2C-LAB-01", model: "Bambu Lab H2C", serial: SERIAL, firmware: "01.03.00.00", buildVolumeMm: [300, 320, 320] });
    });
    expect(f.connects[0]).toMatchObject({ username: "bblp", password: CODE });
  });

  it("notices when the printer runs different firmware from the profile", async () => {
    const f = await start({ firmware: "01.03.01.00" });
    const fw = await withPrinter(await pinned(f), CODE, (p) => readFirmware(p));
    expect(fw).toMatchObject({ firmware: "01.03.01.00", matches: false });
  });

  it("refuses to talk to a printer whose certificate doesn't match the pin, before sending credentials", async () => {
    const f = await start();
    const cfg = await pinned(f);
    const other = makeCert(SERIAL);
    await expect(withPrinter({ ...cfg, mqttFingerprint: other.fingerprint }, CODE, async () => 1)).rejects.toBeInstanceOf(PinMismatch);
    await expect(listFiles({ ...cfg, ftpsFingerprint: other.fingerprint }, CODE)).rejects.toThrow(/does not match the pinned/);
    expect(f.connects).toHaveLength(0);
  });

  it("reports a wrong access code or serial clearly", async () => {
    const f = await start();
    const cfg = await pinned(f);
    await expect(BambuPrinter.connect(cfg, "87654321")).rejects.toThrow(/not authorized|bad user name/);
    await expect(listFiles(cfg, "87654321")).rejects.toThrow(/login .*530/);
    await expect(BambuPrinter.connect({ ...cfg, serial: "WRONGSERIAL1" }, CODE)).rejects.toThrow(/refused the subscription.*serial/);
    await expect(BambuPrinter.connect(cfg, "bad code!")).rejects.toThrow(/letters and digits/);
  });

  it("fails cleanly on a hostile oversized packet", async () => {
    const f = await start({ hostileOversize: true });
    const cfg = await pinned(f);
    const p = await BambuPrinter.connect(cfg, CODE).catch((e: Error) => e);
    if (p instanceof Error) expect(p.message).toMatch(/exceeds|closed/);
    else { await expect(p.refresh(2000)).rejects.toThrow(); p.close(); }
  });

  for (const tlsVersion of ["TLSv1.3", "TLSv1.2"] as const) {
    it(`uploads over FTPS with TLS session reuse (${tlsVersion}), never overwriting`, async () => {
      const f = await start({ maxTlsVersion: tlsVersion });
      const cfg = await pinned(f);
      const bytes = sliced();
      expect(await uploadFile(cfg, CODE, bytes, "a.gcode.3mf")).toEqual({ confirmedBy: "226" });
      expect(sha256(f.files.get("a.gcode.3mf")!)).toBe(sha256(bytes));
      expect(f.dataSessionReused).toEqual([true]);
      await expect(uploadFile(cfg, CODE, bytes, "a.gcode.3mf")).rejects.toThrow(/already exists/);
      expect(await listFiles(cfg, CODE)).toEqual(["a.gcode.3mf"]);
    });
  }

  it("the simulated printer refuses a data connection that doesn't resume the TLS session (so the reuse check means something)", async () => {
    const f = await start();
    const c = await FtpsClient.connect({ host: "127.0.0.1", port: f.ftpsPort, fingerprint: f.fingerprint, user: "bblp", password: CODE });
    const pasv = await c.cmd("PASV");
    const m = /(\d+),(\d+)\)/.exec(pasv.text)!;
    const fresh = tls.connect({ host: "127.0.0.1", port: Number(m[1]) * 256 + Number(m[2]), rejectUnauthorized: false });
    fresh.on("error", () => {});
    expect((await c.cmd("STOR x.gcode.3mf")).code).toBe(150);
    expect((await c.read()).code).toBe(522);
    expect(f.dataSessionReused).toEqual([false]);
    expect(f.files.size).toBe(0);
    c.close();
  });

  it("confirms an upload by size when the printer never sends 226", async () => {
    const f = await start({ skip226: true });
    const cfg = await pinned(f);
    const bytes = sliced();
    expect(await uploadFile(cfg, CODE, bytes, "b.gcode.3mf")).toEqual({ confirmedBy: "size" });
    expect(f.files.get("b.gcode.3mf")!.length).toBe(bytes.length);
  }, 20_000);

  it("uploads a large file intact", async () => {
    const f = await start();
    const cfg = await pinned(f);
    const big = new Uint8Array(12 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    await uploadFile(cfg, CODE, big, "big.gcode.3mf");
    expect(sha256(f.files.get("big.gcode.3mf")!)).toBe(sha256(big));
  }, 30_000);

  it("deletes files and connects to the trusted host, not the address in the PASV reply", async () => {
    const f = await start();
    const cfg = await pinned(f);
    // The fake advertises 10.9.8.7 in PASV; uploads only work because the client ignores it.
    await uploadFile(cfg, CODE, sliced(), "c.gcode.3mf");
    const c = await FtpsClient.connect({ host: "127.0.0.1", port: f.ftpsPort, fingerprint: f.fingerprint, user: "bblp", password: CODE });
    await c.remove("c.gcode.3mf");
    expect(await c.size("c.gcode.3mf")).toBeNull();
    await expect(c.cmd("NOOP\r\nDELE x")).rejects.toThrow(/control characters/);
    c.close();
  });

  it("prints: uploads, sends project_file, sees the job start, and produces valid workflow record data", async () => {
    const f = await start();
    const cfg = await pinned(f);
    const bytes = sliced({ filaments: [{ id: 1, type: "PETG", color: "#FFFFFF" }], projectFilaments: 2 });
    const log: string[] = [];
    const r = await startPrint(cfg, CODE, { bytes, localName: "/x/SYN-PH-2001_A.gcode.3mf", source: { kind: "ams", trays: [2] }, jobId: "J-0501", now: () => new Date("2026-11-13T12:00:00Z") }, (l) => log.push(l));
    expect(r.outcome).toBe("started");
    expect(r.firmware).toBe("01.03.00.00");
    expect(log.join("\n")).toMatch(/IDLE[\s\S]*firmware 01\.03\.00\.00[\s\S]*upload confirmed/);
    const sent = f.requests.find((q) => q.print?.command === "project_file")!.print;
    expect(sent).toMatchObject({ url: "ftp:///SYN-PH-2001_A.gcode.3mf", param: "Metadata/plate_1.gcode", md5: inspectSliced(bytes).plate.gcodeMd5, ams_mapping: [2, -1], use_ams: true, task_id: r.taskId });
    expect(f.state.gcode_state === "PREPARE" || f.state.gcode_state === "RUNNING").toBe(true);
    // The record data the operator signs with `tdp record add` passes the workflow schema as-is.
    expect(RecordData.parse(r.records.queueEntry)).toMatchObject({ kind: "queue-entry", jobId: "J-0501", submittedFile: { name: "SYN-PH-2001_A.gcode.3mf", sha256: sha256(bytes) } });
    expect(RecordData.parse(r.records.buildStart)).toEqual({ kind: "build-start", jobId: "J-0501", resource: "H2C-LAB-01", startedAt: "2026-11-13T12:00:00.000Z" });
  });

  it("reports a refusal when Developer Mode is off (err_code reply), after uploading nothing it can't use", async () => {
    const f = await start({ devMode: false, refusal: "err_code" });
    const r = await startPrint(await pinned(f), CODE, { bytes: sliced(), localName: "a.gcode.3mf", source: { kind: "spool", side: "left" } });
    expect(r.outcome).toBe("rejected");
    expect(r.message).toMatch(/permission denied[\s\S]*Developer Mode/);
    expect(r.records.buildStart).toBeUndefined();
  });

  it("reports a refusal raised as the command-verification HMS", async () => {
    const f = await start({ devMode: false, refusal: "hms" });
    const r = await startPrint(await pinned(f), CODE, { bytes: sliced(), localName: "a.gcode.3mf", source: { kind: "spool", side: "right" } });
    expect(r.outcome).toBe("rejected");
    expect(r.message).toMatch(/0500-0500-0001-0007[\s\S]*Developer Mode/);
  });

  it("says so when the printer ignores the command", async () => {
    const f = await start({ devMode: false, refusal: "silent" });
    const r = await startPrint(await pinned(f), CODE, { bytes: sliced(), localName: "a.gcode.3mf", source: { kind: "spool", side: "left" }, startTimeoutMs: 300 });
    expect(r.outcome).toBe("no-reply");
    expect(r.records.buildStart).toBeUndefined();
  }, 40_000);

  it("won't send a job to a busy printer, and checks the mapping before touching the printer", async () => {
    const f = await start({ initialState: "RUNNING" });
    const cfg = await pinned(f);
    await expect(startPrint(cfg, CODE, { bytes: sliced(), localName: "a.gcode.3mf", source: { kind: "spool", side: "left" } })).rejects.toThrow(/printer is RUNNING/);
    expect(f.files.size).toBe(0);
    const two = sliced({ filaments: [{ id: 1, type: "PETG", color: "#fff" }, { id: 2, type: "PLA", color: "#000" }] });
    await expect(startPrint(cfg, CODE, { bytes: two, localName: "a.gcode.3mf", source: { kind: "spool", side: "left" } })).rejects.toThrow(/only one/);
    await expect(startPrint(cfg, CODE, { bytes: zipSync({ "3D/3dmodel.model": enc("<model/>") }), localName: "a.3mf", source: { kind: "spool", side: "left" } })).rejects.toThrow(/no sliced plate/);
    expect(f.connects).toHaveLength(1); // only the busy check connected
  });

  it("watches a job to the end and produces build-complete data", async () => {
    const f = await start({ autoRun: "finish" });
    const cfg = await pinned(f);
    const bytes = sliced();
    const r = await startPrint(cfg, CODE, { bytes, localName: "a.gcode.3mf", source: { kind: "spool", side: "left" }, jobId: "J-1" });
    const seen: string[] = [];
    const w = await watch(cfg, CODE, { untilDone: true, onUpdate: (s) => seen.push(s.state), job: { jobId: "J-1", sha256: r.project.sha256, startedAt: "2026-11-13T12:00:00.000Z" }, now: () => new Date("2026-11-13T13:00:00Z") });
    expect(w.final.state).toBe("FINISH");
    expect(seen.at(-1)).toBe("FINISH");
    expect(RecordData.parse(w.buildComplete)).toEqual({ kind: "build-complete", jobId: "J-1", submittedFileSha256: sha256(bytes), startedAt: "2026-11-13T12:00:00.000Z", completedAt: "2026-11-13T13:00:00.000Z", errors: [], settings: { finalState: "FINISH" } });
  });

  it("records the printer's errors when a job fails", async () => {
    const f = await start({ autoRun: "fail" });
    const cfg = await pinned(f);
    const r = await startPrint(cfg, CODE, { bytes: sliced(), localName: "a.gcode.3mf", source: { kind: "spool", side: "left" }, jobId: "J-2" });
    const w = await watch(cfg, CODE, { untilDone: true, onUpdate: () => {}, job: { jobId: "J-2", sha256: r.project.sha256, startedAt: "2026-11-13T12:00:00.000Z" } });
    expect(w.final.state).toBe("FAILED");
    const bc = RecordData.parse(w.buildComplete);
    expect(bc.kind === "build-complete" && bc.errors).toEqual(["print_error 0x0300400c", "HMS 0300-0300-0001-0004", "printer reported FAILED"]);
  });

  it("pauses, resumes and stops, and refuses controls that don't fit the state", async () => {
    const f = await start();
    const cfg = await pinned(f);
    await expect(control(cfg, CODE, "pause")).rejects.toThrow(/IDLE; nothing to pause/);
    await startPrint(cfg, CODE, { bytes: sliced(), localName: "a.gcode.3mf", source: { kind: "spool", side: "left" } });
    await expect.poll(() => f.state.gcode_state).toBe("RUNNING");
    expect(await control(cfg, CODE, "pause")).toMatchObject({ outcome: "accepted", before: "RUNNING", after: "PAUSE" });
    await expect(control(cfg, CODE, "pause")).rejects.toThrow(/PAUSE; nothing to pause/);
    expect(await control(cfg, CODE, "resume")).toMatchObject({ outcome: "accepted", after: "RUNNING" });
    expect(await control(cfg, CODE, "stop")).toMatchObject({ outcome: "accepted", after: "IDLE" });
    expect(f.requests.filter((q) => q.print).map((q) => q.print.command)).toEqual(["project_file", "pause", "resume", "stop"]);
  });

  it("refuses controls without Developer Mode", async () => {
    const f = await start({ devMode: false, initialState: "RUNNING" });
    expect(await control(await pinned(f), CODE, "pause")).toMatchObject({ outcome: "rejected", after: "RUNNING" });
  });

  it("drives the CLI end to end: pin, status, firmware, inspect, print, watch", async () => {
    const certs = makeCert(SERIAL);
    const f = await start({ autoRun: "finish", stepMs: 200, certs });
    const dir = mkdtempSync(join(tmpdir(), "printer-cli-"));
    const run = (args: string[], env: Record<string, string> = {}) => promisify(execFile)(process.execPath, ["--import", "tsx", "tools/printer.ts", ...args], { env: { ...process.env, ...env }, timeout: 60_000 }).then((r) => ({ code: 0, ...r }), (e: { code: number; stdout: string; stderr: string }) => e);
    const cfg = await pinned(f);
    writeFileSync(join(dir, "printer.json"), JSON.stringify(cfg));
    const file = join(dir, "latch.gcode.3mf");
    writeFileSync(file, sliced());
    const env = { BAMBU_ACCESS_CODE: CODE };
    const pr = join(dir, "printer.json");

    expect((await run([])).stdout).toMatch(/printer print <file\.gcode\.3mf>/);
    const st = await run(["status", "--printer", pr], env);
    expect(st.stdout).toMatch(/state\s+IDLE/);
    const fw = await run(["firmware", "--printer", pr, "--resource-out", join(dir, "resource.json")], env);
    expect(fw.stdout).toMatch(/printer firmware 01\.03\.00\.00 matches the H2C profile/);
    expect(JSON.parse(readFileSync(join(dir, "resource.json"), "utf8")).firmware).toBe("01.03.00.00");
    expect((await run(["inspect", file])).stdout).toMatch(/plate 1 .*md5 [0-9a-f]{32}, matches the slicer's MD5/);
    expect((await run(["print", file, "--printer", pr, "--yes"], env)).stderr).toMatch(/--ams .* or --spool/);
    const noCode = await run(["print", file, "--printer", pr, "--spool", "left", "--yes"], { BAMBU_ACCESS_CODE: "" });
    expect(noCode.code).not.toBe(0);
    const p = await run(["print", file, "--printer", pr, "--spool", "left", "--yes", "--job", "J-0601", "--records", join(dir, "rec")], env);
    expect(p.stdout).toMatch(/STARTED: job J-0601/);
    const q = JSON.parse(readFileSync(join(dir, "rec", "queue-entry.json"), "utf8"));
    const b = JSON.parse(readFileSync(join(dir, "rec", "build-start.json"), "utf8"));
    expect(RecordData.parse(q).kind).toBe("queue-entry");
    const w = await run(["watch", "--printer", pr, "--until-done", "--job", "J-0601", "--sha256", q.submittedFile.sha256, "--started-at", b.startedAt, "--records", join(dir, "rec")], env);
    expect(w.stdout).toMatch(/FINISH/);
    expect(RecordData.parse(JSON.parse(readFileSync(join(dir, "rec", "build-complete.json"), "utf8")))).toMatchObject({ kind: "build-complete", jobId: "J-0601", errors: [] });
    // Refused (Developer Mode off): exit 1, no records, and the cleanup command is offered and works.
    await f.close();
    const off = await startFakeH2C({ serial: SERIAL, accessCode: CODE, devMode: false, refusal: "err_code", certs });
    fake = off;
    const offPr = join(dir, "off.json");
    writeFileSync(offPr, JSON.stringify({ ...cfg, mqttPort: off.mqttPort, ftpsPort: off.ftpsPort }));
    const refused = await run(["print", file, "--printer", offPr, "--spool", "left", "--yes", "--records", join(dir, "rec-off")], env);
    expect(refused.code).toBe(1);
    expect(refused.stdout).toMatch(/REJECTED: .*Developer Mode[\s\S]*printer delete latch\.gcode\.3mf/);
    expect(existsSync(join(dir, "rec-off"))).toBe(false);
    expect((await run(["files", "--printer", offPr], env)).stdout.trim()).toBe("latch.gcode.3mf");
    expect((await run(["delete", "latch.gcode.3mf", "--printer", offPr, "--yes"], env)).stdout).toMatch(/deleted/);
    expect(off.files.size).toBe(0);
    const bad = await run(["status", "--printer", offPr], { BAMBU_ACCESS_CODE: "00000000" });
    expect(bad.code).toBe(1);
    expect(bad.stderr).toMatch(/refused the MQTT connection/);
  }, 120_000);
});

it("never ships in the browser bundle", () => {
  // The viewer stays network-free: nothing under src/ may import the bridge.
  const out = promisify(execFile)("grep", ["-rlE", "tools/bambu|node:tls|node:dgram", "src"]).then((r) => r.stdout, () => "");
  return expect(out).resolves.toBe("");
});

