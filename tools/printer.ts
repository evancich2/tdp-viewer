// printer: the LAN bridge between tdp-viewer's workflow and a Bambu Lab H2C. A separate local CLI;
// the browser app never touches the network. See docs/printer-bridge.md.
//
//   printer discover [--seconds 15]                                    (listen for printers announcing themselves)
//   printer pin --host <ip> --resource <id> [--serial <sn>] [--model "Bambu Lab H2C"] --out <printer.json> [--force]
//   printer status --printer <printer.json> [--json]
//   printer firmware --printer <printer.json> [--resource-out <resource.json>]
//   printer inspect <file.gcode.3mf> [--plate N]                       (offline: plates, G-code MD5, filaments)
//   printer files --printer <printer.json>
//   printer delete <remote name> --printer <printer.json> [--yes]
//   printer upload <file.gcode.3mf> --printer <printer.json> [--name <remote name>]
//   printer print <file.gcode.3mf> --printer <printer.json> (--ams <tray,...> | --spool left|right) [--plate N] [--name <remote>] [--job <jobId>]
//                 [--no-bed-leveling] [--flow-cali] [--vibration-cali] [--layer-inspect] [--timelapse] [--bed-type auto] [--records <dir>] [--yes]
//   printer watch --printer <printer.json> [--until-done] [--job <jobId> --sha256 <hex> --started-at <ISO> --records <dir>]
//   printer pause|resume --printer <printer.json>
//   printer stop --printer <printer.json> [--yes]
//
// The LAN access code comes from BAMBU_ACCESS_CODE or a hidden prompt; it's never written to disk.
// Printing and control need LAN Only mode and Developer Mode on the printer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { control, deleteFile, formatStatus, listFiles, pinPrinter, readFirmware, remoteNameFor, startPrint, suitabilityResource, uploadFile, watch, withPrinter } from "./bambu/commands";
import { discover } from "./bambu/discover";
import { PrinterFile } from "./bambu/h2c";
import { inspectSliced } from "./bambu/sliced";

const USAGE = readFileSync(new URL(import.meta.url), "utf8").split("\n").filter((l) => /^\/\/   (printer|  )/.test(l)).map((l) => l.slice(5)).join("\n");

function die(msg: string, code = 2): never {
  console.error(msg);
  process.exit(code);
}

async function ask(question: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY) die(hidden ? "no terminal for the access code prompt; set BAMBU_ACCESS_CODE" : "no terminal to confirm; pass --yes");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => { if (s.startsWith(question)) process.stdout.write(question); };
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  if (hidden) process.stdout.write("\n");
  return answer.trim();
}

const accessCode = async () => process.env.BAMBU_ACCESS_CODE?.trim() || (await ask("Printer LAN access code: ", true));
const confirm = async (yes: boolean | undefined, what: string) => {
  if (yes) return;
  if ((await ask(`${what} Type "yes" to continue: `, false)).toLowerCase() !== "yes") die("cancelled", 1);
};

function loadPrinter(path?: string): PrinterFile {
  if (!path) die("--printer <printer.json> is required (make one with: printer pin)");
  const r = PrinterFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
  if (!r.success) die(`${path} is not a printer file: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return r.data;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + "\n";
const writeNew = (path: string, v: unknown, force = false) => {
  if (existsSync(path) && !force) die(`${path} already exists; not overwriting`);
  writeFileSync(path, json(v));
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { values: a, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      seconds: { type: "string" }, host: { type: "string" }, resource: { type: "string" }, serial: { type: "string" }, model: { type: "string" },
      out: { type: "string" }, force: { type: "boolean" }, printer: { type: "string" }, json: { type: "boolean" }, "resource-out": { type: "string" },
      plate: { type: "string" }, name: { type: "string" }, ams: { type: "string" }, spool: { type: "string" }, job: { type: "string" },
      "no-bed-leveling": { type: "boolean" }, "flow-cali": { type: "boolean" }, "vibration-cali": { type: "boolean" }, "layer-inspect": { type: "boolean" },
      timelapse: { type: "boolean" }, "bed-type": { type: "string" }, records: { type: "string" }, yes: { type: "boolean" },
      "until-done": { type: "boolean" }, sha256: { type: "string" }, "started-at": { type: "string" },
    },
  });
  const plate = a.plate === undefined ? undefined : Number(a.plate);
  if (plate !== undefined && !(Number.isInteger(plate) && plate > 0)) die("--plate must be a plate number (1, 2, ...)");

  switch (cmd) {
    case "discover": {
      const secs = Number(a.seconds ?? 15);
      console.log(`listening ${secs} s for Bambu Lab printers (UDP 2021/1990)…`);
      const found = await discover(secs, (p) => console.log(`${p.host}  serial ${p.serial ?? "?"}  model ${p.model ?? "?"}  name ${p.name ?? "?"}  ${p.connect ? `mode ${p.connect}` : ""}${p.claimedHost ? `  (claims ${p.claimedHost})` : ""}`));
      if (!found.length) die("no printers heard. The printer must be on, awake and on this network (same subnet; no client isolation). You can still pin it by IP.", 1);
      return;
    }
    case "pin": {
      if (!a.host || !a.resource || !a.out) die("usage: printer pin --host <ip> --resource <id> [--serial <sn>] --out <printer.json>");
      if (existsSync(a.out) && !a.force) die(`${a.out} already exists; pass --force to re-pin`);
      const r = await pinPrinter({ host: a.host, resourceId: a.resource, serial: a.serial, model: a.model });
      console.log(`MQTT (8883) certificate: CN=${r.mqtt.subjectCN ?? "?"} issued by ${r.mqtt.issuerCN ?? "?"}, valid to ${r.mqtt.validTo ?? "?"}`);
      console.log(`  SHA-256 ${r.mqtt.fingerprint256}`);
      if (r.ftps) console.log(`FTPS (990) certificate: CN=${r.ftps.subjectCN ?? "?"}\n  SHA-256 ${r.ftps.fingerprint256}`);
      else console.log(`FTPS (990) not pinned: ${r.ftpsError}. Uploads need LAN Only mode; pin again once it's on.`);
      console.log(`serial ${r.file.serial}: check it matches the printer's screen (Settings > Device) before trusting this file.`);
      writeNew(a.out, r.file, a.force);
      console.log(`wrote ${a.out}`);
      return;
    }
    case "status": {
      const cfg = loadPrinter(a.printer);
      const code = await accessCode();
      await withPrinter(cfg, code, async (p) => {
        const s = await p.refresh();
        if (a.json) console.log(json(p.state));
        else { console.log(`${cfg.resourceId} ${cfg.model} ${cfg.serial} at ${cfg.host}`); for (const l of formatStatus(s)) console.log(`  ${l}`); }
      });
      return;
    }
    case "firmware": {
      const cfg = loadPrinter(a.printer);
      const code = await accessCode();
      const fw = await withPrinter(cfg, code, (p) => readFirmware(p));
      for (const m of fw.modules) console.log(`  ${m.name.padEnd(12)} sw ${m.swVersion ?? "?"}${m.hwVersion ? `  hw ${m.hwVersion}` : ""}${m.serial ? `  sn ${m.serial}` : ""}`);
      console.log(`printer firmware ${fw.firmware ?? "not reported"}${fw.profileFirmware ? (fw.matches ? ` matches the H2C profile` : ` DIFFERS from the H2C profile (${fw.profileFirmware}); update src/core/printers.ts and review suitability`) : ""}`);
      if (a["resource-out"]) { writeNew(a["resource-out"], suitabilityResource(cfg, fw.firmware)); console.log(`wrote ${a["resource-out"]} (the resource block for a suitability record, firmware read from the machine)`); }
      if (fw.profileFirmware && !fw.matches) process.exit(1);
      return;
    }
    case "inspect": {
      const file = positionals[0] ?? die("usage: printer inspect <file.gcode.3mf> [--plate N]");
      const p = inspectSliced(readFileSync(file), plate);
      console.log(`${basename(file)}: ${p.bytes} bytes, sha256 ${p.sha256}`);
      console.log(`  sliced plates ${p.plates.join(", ")}; using plate ${p.plate.plate} (${p.plate.gcodePath}, ${p.plate.gcodeBytes} bytes, md5 ${p.plate.gcodeMd5}${p.plate.declaredMd5 ? ", matches the slicer's MD5" : ""})`);
      if (p.plate.printerModelId) console.log(`  sliced for printer model id ${p.plate.printerModelId}${p.plate.nozzleDiameters ? `, nozzle ${p.plate.nozzleDiameters} mm` : ""}`);
      if (p.plate.predictionSeconds) console.log(`  estimated ${Math.round(p.plate.predictionSeconds / 60)} min${p.plate.weightGrams ? `, ${p.plate.weightGrams} g` : ""}`);
      console.log(`  project filaments ${p.projectFilaments}; plate uses ${p.plate.filaments.map((f) => `#${f.id} ${f.type ?? "?"} ${f.color ?? ""}`.trim()).join(", ") || "(not listed)"}`);
      console.log(`  remote name would be ${remoteNameFor(file)}`);
      return;
    }
    case "files": {
      const cfg = loadPrinter(a.printer);
      for (const f of await listFiles(cfg, await accessCode())) console.log(f);
      return;
    }
    case "delete": {
      const name = positionals[0] ?? die("usage: printer delete <remote name> --printer <printer.json>");
      const cfg = loadPrinter(a.printer);
      await confirm(a.yes, `This deletes ${name} from the printer's storage.`);
      await deleteFile(cfg, await accessCode(), name);
      console.log(`deleted ${name}`);
      return;
    }
    case "upload": {
      const file = positionals[0] ?? die("usage: printer upload <file.gcode.3mf> --printer <printer.json>");
      const cfg = loadPrinter(a.printer);
      const bytes = readFileSync(file);
      const p = inspectSliced(bytes, plate);
      const name = a.name ?? remoteNameFor(file);
      const r = await uploadFile(cfg, await accessCode(), bytes, name);
      console.log(`uploaded ${name} (${bytes.length} bytes, sha256 ${p.sha256}); confirmed by ${r.confirmedBy === "226" ? "transfer completion" : "file size"}`);
      return;
    }
    case "print": {
      const file = positionals[0] ?? die("usage: printer print <file.gcode.3mf> --printer <printer.json> (--ams 0,1 | --spool left|right)");
      const cfg = loadPrinter(a.printer);
      if (!!a.ams === !!a.spool) die("say where the filament comes from: --ams <tray per project filament, e.g. 0 or 0,1,-1> or --spool left|right");
      if (a.spool && a.spool !== "left" && a.spool !== "right") die("--spool is left or right");
      const source = a.ams ? { kind: "ams" as const, trays: a.ams.split(",").map((t) => Number(t.trim())) } : { kind: "spool" as const, side: a.spool as "left" | "right" };
      const bytes = readFileSync(file);
      const p = inspectSliced(bytes, plate);
      if (a.records && existsSync(join(a.records, "queue-entry.json"))) die(`${a.records}/queue-entry.json already exists; not overwriting`);
      console.log(`${basename(file)} plate ${p.plate.plate} → ${cfg.resourceId} (${cfg.model}, ${cfg.serial} at ${cfg.host})`);
      await confirm(a.yes, "This starts a print on a real machine. Check the plate is clear and the right filament is loaded.");
      const r = await startPrint(cfg, await accessCode(), {
        bytes, localName: file, remoteName: a.name, plate, source, jobId: a.job,
        bedLeveling: !a["no-bed-leveling"], flowCalibration: !!a["flow-cali"], vibrationCalibration: !!a["vibration-cali"],
        layerInspect: !!a["layer-inspect"], timelapse: !!a.timelapse, bedType: a["bed-type"],
      }, (l) => console.log(`  ${l}`));
      console.log(`${r.outcome.toUpperCase()}: ${r.message}`);
      // A refused job was never queued, so it gets no records. Without a reply the job may or may
      // not be queued; the queue entry is written and the operator checks the printer's screen.
      if (a.records && r.outcome !== "rejected") {
        mkdirSync(a.records, { recursive: true });
        writeNew(join(a.records, "queue-entry.json"), r.records.queueEntry);
        if (r.records.buildStart) writeNew(join(a.records, "build-start.json"), r.records.buildStart);
        console.log(`wrote record data to ${a.records}/ for "tdp record add --data" (queue-entry${r.records.buildStart ? ", build-start" : ""})`);
      }
      if (r.outcome === "rejected") { console.log(`the file stays on the printer as ${r.remoteName}; remove it with: printer delete ${r.remoteName} --printer ${a.printer}`); process.exit(1); }
      if (r.outcome !== "started") process.exit(3);
      return;
    }
    case "watch": {
      const cfg = loadPrinter(a.printer);
      const job = a.job ? { jobId: a.job, sha256: a.sha256 ?? die("--job needs --sha256 (the submitted file's) and --started-at"), startedAt: a["started-at"] ?? die("--job needs --started-at") } : undefined;
      const r = await watch(cfg, await accessCode(), {
        untilDone: a["until-done"], job,
        onUpdate: (s) => console.log(`${new Date().toISOString()}  ${formatStatus(s).join("  |  ")}`),
      });
      if (r.buildComplete && a.records) {
        mkdirSync(a.records, { recursive: true });
        writeNew(join(a.records, "build-complete.json"), r.buildComplete);
        console.log(`wrote ${a.records}/build-complete.json (record outcome: ${r.final.state === "FINISH" ? "completed" : "failed"})`);
      }
      return;
    }
    case "pause":
    case "resume":
    case "stop": {
      const cfg = loadPrinter(a.printer);
      if (cmd === "stop") await confirm(a.yes, "This cancels the print on the printer; it can't be resumed.");
      const r = await control(cfg, await accessCode(), cmd);
      console.log(`${r.outcome.toUpperCase()}: ${r.message}; printer ${r.before} → ${r.after}`);
      if (r.outcome === "rejected") process.exit(1);
      return;
    }
    default:
      console.log(USAGE);
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((e) => die(`error: ${(e as Error).message}`, 1));
