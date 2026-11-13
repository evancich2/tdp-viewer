import { createRequire } from "node:module";
import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import {
  AccessDenied,
  AuditLog,
  PackageSession,
  buildPackage,
  defaultPolicy,
  exportForPrint,
  generateKeyPair,
  meshStats,
  weld,
  type Policy,
  type StepMesher,
  type TrustStore,
} from "../src/core";
import { utf8 } from "../src/core/bytes";
import { meshStep, type Occt } from "../src/mesh/occt";
import { PRINTERS, checkFit } from "../src/core/printers";
import { sampleContents } from "../tools/sample-data";
import { writeStep } from "../tools/step-writer";

const now = new Date("2026-06-01T00:00:00Z");
const iso = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString();

let occt: Occt;
const nodeMesher: StepMesher = async (step) => meshStep(occt, step);
let tdp: Uint8Array;
let store: TrustStore;

beforeAll(async () => {
  occt = (await createRequire(import.meta.url)("occt-import-js")()) as Occt;
  const [author, approver] = await Promise.all([generateKeyPair(), generateKeyPair()]);
  const key = (k: typeof author, role: "author" | "approver") => ({
    keyId: k.keyId, name: role, publicKey: k.publicKey, roles: [role], notBefore: iso(-10), notAfter: iso(365), revoked: false,
  });
  store = { schema: "tdp-truststore/0.1", keys: [key(author, "author"), key(approver, "approver")] };
  const { inputs, bom } = sampleContents();
  tdp = await buildPackage(
    { id: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", title: "Test", partNumber: "SMP-1000", revision: "B", created: iso(-1) },
    inputs, bom, [{ ...author, role: "author" }, { ...approver, role: "approver" }], now,
  );
}, 30_000);

const open = (policy: Policy = defaultPolicy) => PackageSession.open("t.tdp", tdp, store, policy, new AuditLog(() => now), now);

describe("STEP meshing", () => {
  it("tessellates the sample bracket into a watertight solid of the right size", () => {
    const step = writeStep("P-1", "Bracket", [{ outline: [[0, 0], [60, 0], [60, 5], [5, 5], [5, 40], [0, 40]], z0: 0, height: 30 }]);
    const [mesh] = meshStep(occt, step).map((m) => weld(m));
    const s = meshStats(mesh!);
    expect(s.watertight).toBe(true);
    expect(s.triangles).toBe(20);
    expect(s.min).toEqual([0, 0, 0]);
    expect(s.max).toEqual([60, 40, 30]);
  });

  it("flags a mesh with a missing face as not watertight", () => {
    const step = writeStep("P-2", "Cube", [{ outline: [[0, 0], [10, 0], [10, 10], [0, 10]], z0: 0, height: 10 }]);
    const mesh = weld(meshStep(occt, step)[0]!);
    const holed = { ...mesh, indices: Array.from(mesh.indices).slice(6) };
    expect(meshStats(holed).watertight).toBe(false);
  });
});

describe("exportForPrint", () => {
  it("writes a 3MF with every solid and provenance back to the signed package", async () => {
    const session = await open();
    expect(session.trusted).toBe(true);
    const out = await exportForPrint(session, "models/SMP-1000_B.stp", nodeMesher, { now });

    expect(out.fileName).toBe("SMP-1000_B.3mf");
    expect(out.meshes.every((m) => m.stats.watertight)).toBe(true);
    const files = unzipSync(out.bytes);
    expect(Object.keys(files).sort()).toEqual(["3D/3dmodel.model", "[Content_Types].xml", "_rels/.rels"]);
    const model = utf8.decode(files["3D/3dmodel.model"]!);
    expect(model).toContain('unit="millimeter"');
    expect(model.match(/<object /g)?.length).toBe(out.meshes.length);
    expect(model).toContain(`<metadata name="tdp:ManifestSha256">${session.result.manifestSha256}</metadata>`);
    const sourceSha = session.manifest!.files.find((f) => f.path === "models/SMP-1000_B.stp")!.sha256;
    expect(model).toContain(`<metadata name="tdp:SourceSha256">${sourceSha}</metadata>`);

    const log = await session.audit.list();
    expect(log.map((e) => e.action)).toEqual(["load", "verify", "open", "export"]);
    expect(log.at(-1)!.detail).toContain(out.sha256);
    expect(out.printer.name).toBe("Bambu Lab H2C");
    expect(out.fits).toBe(true);
    expect(model).toContain('<metadata name="tdp:TargetPrinter">Bambu Lab H2C</metadata>');
    expect(model).toContain('<metadata name="tdp:TargetPrinterFirmware">01.03.00.00</metadata>');
    expect(log.at(-1)!.detail).toContain("fits Bambu Lab H2C (firmware 01.03.00.00)");
  });

  it("leaves printer and firmware out of the 3MF when no printer is targeted", async () => {
    const generic = PRINTERS.find((p) => p.id === "generic")!;
    const out = await exportForPrint(await open(), "models/SMP-1000_B.stp", nodeMesher, { now, printer: generic });
    const model = utf8.decode(unzipSync(out.bytes)["3D/3dmodel.model"]!);
    expect(model).not.toContain("tdp:TargetPrinter");
  });

  it("omits the firmware for a printer profile that doesn't record one", async () => {
    const other = { id: "o", name: "Other", buildVolume: [500, 500, 500] as [number, number, number] };
    const out = await exportForPrint(await open(), "models/SMP-1000_B.stp", nodeMesher, { now, printer: other });
    const model = utf8.decode(unzipSync(out.bytes)["3D/3dmodel.model"]!);
    expect(model).toContain('<metadata name="tdp:TargetPrinter">Other</metadata>');
    expect(model).not.toContain("tdp:TargetPrinterFirmware");
  });

  it("flags parts too large for the target printer", async () => {
    const tiny = { id: "tiny", name: "Tiny", buildVolume: [50, 50, 50] as [number, number, number] };
    const out = await exportForPrint(await open(), "models/SMP-1000_B.stp", nodeMesher, { now, printer: tiny });
    expect(out.fits).toBe(false);
    expect(out.meshes.find((m) => !m.fit.fits)?.fit.size).toEqual([60, 40, 30]); // the bracket
  });

  it("refuses non-model files", async () => {
    const session = await open();
    await expect(exportForPrint(session, "drawings/SMP-1001_A.pdf", nodeMesher, { now })).rejects.toBeInstanceOf(AccessDenied);
    expect((await session.audit.list()).at(-1)!.action).toBe("deny");
  });

  it("refuses when policy disables print export", async () => {
    const session = await open({ ...defaultPolicy, print: { ...defaultPolicy.print, allowExport: false } });
    await expect(exportForPrint(session, "models/SMP-1001_A.stp", nodeMesher, { now })).rejects.toThrow(/disabled by policy/);
  });

  it("refuses models from an untrusted package", async () => {
    const session = await PackageSession.open("t.tdp", tdp, { ...store, keys: [] }, defaultPolicy, new AuditLog(), now);
    await expect(exportForPrint(session, "models/SMP-1001_A.stp", nodeMesher, { now })).rejects.toThrow(/not trusted/);
  });

  it("refuses meshes that aren't watertight", async () => {
    const session = await open();
    const leaky: StepMesher = async (step) => {
      const [m] = await nodeMesher(step);
      return [{ ...m!, indices: Array.from(m!.indices).slice(3) }];
    };
    await expect(exportForPrint(session, "models/SMP-1001_A.stp", leaky, { now })).rejects.toThrow(/not watertight/);
  });
});

describe("checkFit", () => {
  const h2c = PRINTERS.find((p) => p.id === "bambu-h2c")!;
  it("records the H2C's firmware in Bambu's XX.XX.XX.XX form", () => {
    expect(h2c.firmware).toBe("01.03.00.00");
    expect(h2c.firmware).toMatch(/^\d{2}\.\d{2}\.\d{2}\.\d{2}$/);
  });
  it("lets the slicer rotate the part", () => {
    expect(checkFit([319, 10, 10], h2c).fits).toBe(true); // longest side along Y
    expect(checkFit([321, 321, 10], h2c).fits).toBe(false);
    expect(checkFit([300, 320, 320], h2c).fits).toBe(true);
  });
});
