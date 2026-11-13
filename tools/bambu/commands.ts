// The printer bridge's operations, separate from argument parsing so they can be tested against a
// simulated printer. Nothing here is imported by the browser app: the viewer stays network-free.
import { PRINTERS } from "../../src/core/printers";
import { FtpsClient, checkRemoteName } from "./ftps";
import { BambuPrinter, FTPS_PORT, LAN_USER, MQTT_PORT, PrinterFile, buildMapping, controlCommand, projectFileCommand, type FilamentSource, type Module, type StatusSummary } from "./h2c";
import { connectPinned, type PeerCert } from "./pinned";
import { inspectSliced, type SlicedProject } from "./sliced";

export type Log = (line: string) => void;
const H2C = PRINTERS.find((p) => p.id === "bambu-h2c")!;

// ---- pin ----

export interface PinResult { file: PrinterFile; mqtt: PeerCert; ftps?: PeerCert; ftpsError?: string }

/** Reads the certificates the printer presents and builds a printer file pinning them. */
export async function pinPrinter(o: { host: string; resourceId: string; serial?: string; model?: string; mqttPort?: number; ftpsPort?: number; now?: Date; timeoutMs?: number }): Promise<PinResult> {
  const read = async (port: number) => {
    const { socket, cert } = await connectPinned({ host: o.host, port, allowUnpinned: true, timeoutMs: o.timeoutMs ?? 8000 });
    socket.destroy();
    return cert;
  };
  const mqtt = await read(o.mqttPort ?? MQTT_PORT);
  let ftps: PeerCert | undefined, ftpsError: string | undefined;
  try { ftps = await read(o.ftpsPort ?? FTPS_PORT); } catch (e) { ftpsError = (e as Error).message; }
  // Bambu printer certificates carry the serial number as their common name.
  const serial = o.serial ?? (mqtt.subjectCN && /^[A-Za-z0-9]{8,32}$/.test(mqtt.subjectCN) ? mqtt.subjectCN : undefined);
  if (!serial) throw new Error(`the certificate's common name (${mqtt.subjectCN ?? "none"}) isn't a printer serial; pass --serial from the printer's screen`);
  const file = PrinterFile.parse({
    schema: "tdp-printer/0.1",
    resourceId: o.resourceId,
    model: o.model ?? H2C.name,
    host: o.host,
    serial,
    ...(o.mqttPort ? { mqttPort: o.mqttPort } : {}),
    ...(o.ftpsPort ? { ftpsPort: o.ftpsPort } : {}),
    mqttFingerprint: mqtt.fingerprint256,
    ...(ftps ? { ftpsFingerprint: ftps.fingerprint256 } : {}),
    pinnedAt: (o.now ?? new Date()).toISOString(),
  });
  return { file, mqtt, ftps, ftpsError };
}

// ---- status and firmware ----

export async function withPrinter<T>(cfg: PrinterFile, accessCode: string, fn: (p: BambuPrinter) => Promise<T>, timeoutMs?: number): Promise<T> {
  const p = await BambuPrinter.connect(cfg, accessCode, timeoutMs);
  try { return await fn(p); } finally { p.close(); }
}

export function formatStatus(s: StatusSummary): string[] {
  const out = [`state      ${s.state}${s.percent !== undefined ? `  ${s.percent}%` : ""}${s.layer ? `  layer ${s.layer}` : ""}${s.remainingMinutes ? `  ${s.remainingMinutes} min left` : ""}`];
  if (s.file) out.push(`job        ${s.file}${s.taskId && s.taskId !== "0" ? ` (task ${s.taskId})` : ""}`);
  const temps = [s.nozzleTemp !== undefined && `nozzle ${s.nozzleTemp} °C`, s.bedTemp !== undefined && `bed ${s.bedTemp} °C`, s.chamberTemp !== undefined && `chamber ${s.chamberTemp} °C`].filter(Boolean);
  if (temps.length) out.push(`temps      ${temps.join(", ")}`);
  if (s.printError) out.push(`error      print_error ${s.printError} (0x${s.printError.toString(16).padStart(8, "0")})`);
  if (s.hms.length) out.push(`HMS        ${s.hms.join(", ")}  (look up at wiki.bambulab.com)`);
  if (s.wifiSignal) out.push(`wifi       ${s.wifiSignal}`);
  return out;
}

export interface FirmwareResult { modules: Module[]; firmware?: string; profileFirmware?: string; matches: boolean }

/** The printer's own firmware version (the "ota" module), compared with the H2C profile. */
export async function readFirmware(p: BambuPrinter): Promise<FirmwareResult> {
  const modules = await p.version();
  const firmware = modules.find((m) => m.name === "ota")?.swVersion;
  const profileFirmware = p.cfg.model === H2C.name ? H2C.firmware : undefined;
  return { modules, firmware, profileFirmware, matches: !!firmware && firmware === profileFirmware };
}

/** The resource block of a suitability record, with the firmware read from the machine. */
export const suitabilityResource = (cfg: PrinterFile, firmware: string | undefined) => ({
  id: cfg.resourceId,
  model: cfg.model,
  serial: cfg.serial,
  firmware: firmware ?? null,
  buildVolumeMm: cfg.model === H2C.name ? H2C.buildVolume : undefined,
});

// ---- files ----

async function withFtps<T>(cfg: PrinterFile, accessCode: string, fn: (f: FtpsClient) => Promise<T>, timeoutMs?: number): Promise<T> {
  if (!cfg.ftpsFingerprint) throw new Error("the printer file has no FTPS certificate pin (port 990 wasn't open when it was pinned). Turn on LAN Only mode and run \"printer pin\" again.");
  const f = await FtpsClient.connect({ host: cfg.host, port: cfg.ftpsPort ?? FTPS_PORT, fingerprint: cfg.ftpsFingerprint, user: LAN_USER, password: accessCode, timeoutMs });
  try { return await fn(f); } finally { f.close(); }
}

export const listFiles = (cfg: PrinterFile, code: string) => withFtps(cfg, code, (f) => f.list());
export const deleteFile = (cfg: PrinterFile, code: string, name: string) => withFtps(cfg, code, (f) => f.remove(checkRemoteName(name)));

/** A name for the printer's storage: the local name, made safe, keeping .gcode.3mf. */
export function remoteNameFor(localName: string): string {
  const base = localName.split(/[\\/]/).pop()!.replace(/\.gcode\.3mf$|\.3mf$/i, "");
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[^A-Za-z0-9]+/, "").replace(/\.\.+/g, ".").slice(0, 150) || "part";
  return checkRemoteName(`${safe}.gcode.3mf`);
}

export async function uploadFile(cfg: PrinterFile, code: string, bytes: Uint8Array, remoteName: string) {
  return withFtps(cfg, code, (f) => f.upload(remoteName, bytes));
}

// ---- print ----

export interface PrintRequest {
  bytes: Uint8Array;
  localName: string;
  remoteName?: string;
  plate?: number;
  source: FilamentSource;
  jobId?: string;
  bedLeveling?: boolean;
  flowCalibration?: boolean;
  vibrationCalibration?: boolean;
  layerInspect?: boolean;
  timelapse?: boolean;
  bedType?: string;
  /** How long to wait for the job to show as started. */
  startTimeoutMs?: number;
  now?: () => Date;
}

export interface PrintResult {
  outcome: "started" | "accepted" | "rejected" | "no-reply";
  message: string;
  project: SlicedProject;
  remoteName: string;
  taskId: string;
  jobId: string;
  firmware?: string;
  /** Data for `tdp record add` (queue-entry then build-start), filled from what was actually sent. */
  records: { queueEntry: Record<string, unknown>; buildStart?: Record<string, unknown> };
}

const BUSY = new Set(["RUNNING", "PREPARE", "PAUSE", "SLICING"]);

export async function startPrint(cfg: PrinterFile, code: string, r: PrintRequest, log: Log = () => {}): Promise<PrintResult> {
  const now = r.now ?? (() => new Date());
  const project = inspectSliced(r.bytes, r.plate);
  const mapping = buildMapping(project, r.source);
  const remoteName = r.remoteName ? checkRemoteName(r.remoteName) : remoteNameFor(r.localName);
  const taskId = String(now().getTime() & 0x7fffffff);
  const jobId = r.jobId ?? `J-${taskId}`;
  const settings: Record<string, string> = {
    plate: String(project.plate.plate),
    filamentSource: r.source.kind === "ams" ? `ams:${mapping.join(",")}` : `spool:${r.source.side}`,
    bedLeveling: String(r.bedLeveling ?? true),
    flowCalibration: String(r.flowCalibration ?? false),
    vibrationCalibration: String(r.vibrationCalibration ?? false),
    layerInspect: String(r.layerInspect ?? false),
    timelapse: String(r.timelapse ?? false),
    bedType: r.bedType ?? "auto",
    gcodeMd5: project.plate.gcodeMd5,
    remoteName,
    printer: `${cfg.resourceId} (${cfg.serial})`,
  };
  const queueEntry = { kind: "queue-entry", jobId, submittedFile: { name: remoteName, sha256: project.sha256 }, settings };

  return withPrinter(cfg, code, async (p) => {
    const status = await p.refresh();
    log(`printer ${cfg.resourceId} is ${status.state}`);
    if (BUSY.has(status.state)) throw new Error(`printer is ${status.state}${status.file ? ` (${status.file})` : ""}; not sending a new job`);
    let firmware: string | undefined;
    try {
      const fw = await readFirmware(p);
      firmware = fw.firmware;
      log(`firmware ${fw.firmware ?? "unknown"}${fw.profileFirmware && !fw.matches ? ` (profile records ${fw.profileFirmware}: update src/core/printers.ts and the suitability record)` : ""}`);
    } catch (e) { log(`firmware not read: ${(e as Error).message}`); }

    log(`uploading ${remoteName} (${project.bytes} bytes, plate ${project.plate.plate}, sha256 ${project.sha256.slice(0, 16)}…)`);
    const up = await uploadFile(cfg, code, r.bytes, remoteName);
    log(`upload confirmed (${up.confirmedBy === "226" ? "transfer complete" : "by file size"})`);

    const cmd = projectFileCommand({
      remoteName, project, mapping, useAms: r.source.kind === "ams", taskId,
      bedLeveling: r.bedLeveling ?? true, flowCalibration: r.flowCalibration ?? false, vibrationCalibration: r.vibrationCalibration ?? false,
      layerInspect: r.layerInspect ?? false, timelapse: r.timelapse ?? false, bedType: r.bedType ?? "auto",
    }, p.nextSequence());
    log("sending project_file");
    const first = await p.command(cmd, { startedTask: taskId, timeoutMs: 20_000 });
    let outcome = first.outcome, message = first.message;
    if (outcome === "accepted" || outcome === "no-reply") {
      // An accepted command isn't a started job: wait until the printer reports it running.
      const started = await p.waitFor(() => (p.summary.taskId === taskId && BUSY.has(p.summary.state) ? p.summary.state : undefined), r.startTimeoutMs ?? 90_000);
      if (started) { outcome = "started"; message = `job ${jobId} (task ${taskId}) is ${started}`; }
      else if (outcome === "accepted") message = "printer accepted the command but hasn't reported the job as started; check its screen";
    }
    const buildStart = outcome === "started" ? { kind: "build-start", jobId, resource: cfg.resourceId, startedAt: now().toISOString() } : undefined;
    return { outcome, message, project, remoteName, taskId, jobId, firmware, records: { queueEntry, buildStart } };
  });
}

export async function control(cfg: PrinterFile, code: string, command: "pause" | "resume" | "stop") {
  return withPrinter(cfg, code, async (p) => {
    const before = await p.refresh();
    if (command === "pause" && before.state !== "RUNNING") throw new Error(`printer is ${before.state}; nothing to pause`);
    if (command === "resume" && before.state !== "PAUSE") throw new Error(`printer is ${before.state}; nothing to resume`);
    if (command === "stop" && !BUSY.has(before.state)) throw new Error(`printer is ${before.state}; nothing to stop`);
    const r = await p.command(controlCommand(command, p.nextSequence()), { timeoutMs: 10_000 });
    const want = command === "pause" ? ["PAUSE"] : command === "resume" ? ["RUNNING"] : ["IDLE", "FAILED", "FINISH"];
    const after = r.outcome === "rejected" ? undefined : await p.waitFor(() => (want.includes(p.summary.state) ? p.summary.state : undefined), 20_000);
    return { ...r, before: before.state, after: after ?? p.summary.state };
  });
}

// ---- watch ----

export interface WatchResult { final: StatusSummary; buildComplete?: Record<string, unknown> }

/** Follows the printer until the job ends (FINISH or FAILED), reporting each change. */
export async function watch(cfg: PrinterFile, code: string, o: { onUpdate: (s: StatusSummary) => void; untilDone?: boolean; maxMs?: number; job?: { jobId: string; sha256: string; startedAt: string } ; now?: () => Date }): Promise<WatchResult> {
  const now = o.now ?? (() => new Date());
  return withPrinter(cfg, code, async (p) => {
    let last = "";
    const emit = () => { const s = p.summary; const k = JSON.stringify([s.state, s.percent, s.layer, s.hms, s.printError]); if (k !== last) { last = k; o.onUpdate(s); } };
    await p.refresh();
    emit();
    if (!o.untilDone) return { final: p.summary };
    let sawWork = BUSY.has(p.summary.state);
    const ended = await p.waitFor(() => {
      emit();
      if (BUSY.has(p.summary.state)) sawWork = true;
      return sawWork && ["FINISH", "FAILED", "IDLE"].includes(p.summary.state) ? p.summary.state : undefined;
    }, o.maxMs ?? 7 * 24 * 3600_000);
    const final = p.summary;
    if (!ended) return { final };
    const errors = [
      ...(final.printError ? [`print_error 0x${final.printError.toString(16).padStart(8, "0")}`] : []),
      ...final.hms.map((h) => `HMS ${h}`),
      ...(ended !== "FINISH" ? [`printer reported ${ended}`] : []),
    ];
    const buildComplete = o.job ? { kind: "build-complete", jobId: o.job.jobId, submittedFileSha256: o.job.sha256, startedAt: o.job.startedAt, completedAt: now().toISOString(), errors, settings: { finalState: ended } } : undefined;
    return { final, buildComplete };
  });
}
