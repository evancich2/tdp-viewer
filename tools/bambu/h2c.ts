// Talking to a Bambu Lab H2C over the LAN: status and firmware over MQTT (port 8883), sliced files
// over FTPS (port 990), and print/pause/resume/stop commands over MQTT.
//
// Bambu publishes no LAN API. Message shapes here follow community documentation and open-source
// clients (see docs/printer-bridge.md); the H2-series print command in particular is
// community-derived and must be confirmed on the lab's printer. Since Bambu's 2025 authorization
// firmware, the printer accepts print and control commands from third-party software only with
// LAN Only mode AND Developer Mode on; status reads work without them.
import { z } from "zod";
import { connectPinned } from "./pinned";
import { MqttClient } from "./mqtt";
import type { SlicedProject } from "./sliced";

export const PrinterFile = z
  .object({
    schema: z.literal("tdp-printer/0.1"),
    /** Resource id used in workflow records, e.g. H2C-LAB-01. */
    resourceId: z.string().min(1).max(64),
    model: z.string().min(1).max(100),
    host: z.string().min(1).max(253).regex(/^[A-Za-z0-9.:-]+$/),
    serial: z.string().min(1).max(64).regex(/^[A-Za-z0-9]+$/),
    /** Only for printers behind port forwarding (and the tests); the printer itself uses 8883/990. */
    mqttPort: z.number().int().min(1).max(65535).optional(),
    ftpsPort: z.number().int().min(1).max(65535).optional(),
    mqttFingerprint: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/),
    ftpsFingerprint: z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/).optional(),
    pinnedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type PrinterFile = z.infer<typeof PrinterFile>;

export const MQTT_PORT = 8883;
export const FTPS_PORT = 990;
export const LAN_USER = "bblp";

/** Authorization refusals reported in err_code (community-documented range). */
export const AUTH_REFUSED = (code: number) => code >= 0x05024007 && code <= 0x0502400b;
/** HMS raised when the printer rejects an unverified (unsigned) MQTT command. */
export const HMS_COMMAND_VERIFICATION = "0500-0500-0001-0007";
export const DEV_MODE_HINT = "On the printer turn on LAN Only mode and then Developer Mode (Settings > Network), and keep the access code shown there.";

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reports after a pushall are incremental, so keep one merged view of the printer. */
export function mergeReport(into: Json, patch: Json): Json {
  for (const [k, v] of Object.entries(patch)) {
    if (k === "__proto__" || k === "constructor" || k === "prototype") continue;
    into[k] = isObj(v) && isObj(into[k]) ? mergeReport(into[k] as Json, v) : v;
  }
  return into;
}

export const hmsCode = (h: { attr?: unknown; code?: unknown }) => {
  const hex = (n: unknown) => (Number(n) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  const a = hex(h.attr), c = hex(h.code);
  return `${a.slice(0, 4)}-${a.slice(4)}-${c.slice(0, 4)}-${c.slice(4)}`;
};

export interface StatusSummary {
  state: string;
  percent?: number;
  remainingMinutes?: number;
  layer?: string;
  file?: string;
  taskId?: string;
  nozzleTemp?: number;
  bedTemp?: number;
  chamberTemp?: number;
  printError?: number;
  hms: string[];
  wifiSignal?: string;
}

export function summarize(print: Json): StatusSummary {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const s = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
  const hms = Array.isArray(print.hms) ? print.hms.filter(isObj).map(hmsCode) : [];
  const layer = n(print.layer_num), total = n(print.total_layer_num);
  return {
    state: s(print.gcode_state) ?? "UNKNOWN",
    percent: n(print.mc_percent),
    remainingMinutes: n(print.mc_remaining_time),
    layer: layer !== undefined && total ? `${layer}/${total}` : undefined,
    file: s(print.subtask_name) ?? s(print.gcode_file),
    taskId: s(print.task_id) ?? (typeof print.task_id === "number" ? String(print.task_id) : undefined),
    nozzleTemp: n(print.nozzle_temper),
    bedTemp: n(print.bed_temper),
    chamberTemp: n(print.chamber_temper),
    printError: n(print.print_error) || undefined,
    hms,
    wifiSignal: s(print.wifi_signal),
  };
}

export interface Reply { accepted: boolean; errCode: number; reason?: string; raw: Json }

/** Reads a command's reply from a report, or undefined if this report isn't the reply. */
export function replyTo(section: string, command: string, sequenceId: string, msg: Json): Reply | undefined {
  const body = msg[section];
  if (!isObj(body) || body.command !== command || String(body.sequence_id) !== sequenceId) return undefined;
  const errCode = Number(body.err_code ?? 0) || 0;
  const result = typeof body.result === "string" ? body.result : undefined;
  const failed = result !== undefined && result.toLowerCase() !== "success";
  const reason = typeof body.reason === "string" && body.reason ? body.reason : undefined;
  return { accepted: errCode === 0 && !failed, errCode, reason, raw: body };
}

export function explainRefusal(r: Reply): string {
  const code = r.errCode ? ` (err_code ${r.errCode}, 0x${r.errCode.toString(16).padStart(8, "0")})` : "";
  const why = r.reason ? `: ${r.reason}` : "";
  return `printer refused the command${why}${code}.${AUTH_REFUSED(r.errCode) || /auth|verif|permission/i.test(r.reason ?? "") ? ` ${DEV_MODE_HINT}` : ""}`;
}

// ---- AMS mapping (H2 series) ----

/**
 * Tray numbering: 0-3 AMS 0, 4-7 AMS 1, ... ; 128+ AMS HT; 254 left external spool, 255 right
 * external spool; -1 unused. ams_mapping2 restates each entry as {ams_id, slot_id}.
 */
export function amsMapping2(tray: number): { ams_id: number; slot_id: number } {
  if (tray < 0) return { ams_id: 255, slot_id: 255 };
  if (tray === 254 || tray === 255) return { ams_id: tray, slot_id: 0 };
  if (tray >= 128) return { ams_id: tray, slot_id: 0 };
  return { ams_id: Math.floor(tray / 4), slot_id: tray % 4 };
}

export type FilamentSource = { kind: "ams"; trays: number[] } | { kind: "spool"; side: "left" | "right" };

/** One tray per project filament; every filament the plate uses must be mapped to something. */
export function buildMapping(project: SlicedProject, source: FilamentSource): number[] {
  const used = project.plate.filaments.map((f) => f.id);
  const len = project.projectFilaments;
  let map: number[];
  if (source.kind === "spool") {
    if (used.length > 1) throw new Error(`plate ${project.plate.plate} uses ${used.length} filaments (${used.join(", ")}); an external spool can feed only one. Map them to AMS trays with --ams.`);
    map = Array.from({ length: len }, () => -1);
    const only = used[0] ?? 1;
    map[only - 1] = source.side === "left" ? 254 : 255;
    return map;
  }
  if (source.trays.length > len) throw new Error(`--ams gives ${source.trays.length} trays but the project has ${len} filaments`);
  for (const t of source.trays) if (!Number.isInteger(t) || t < -1 || (t > 15 && t < 128) || t > 255 || t === 254 || t === 255) throw new Error(`bad AMS tray ${t} (0-15 for AMS trays, 128+ for AMS HT, -1 for unused; use --spool for the external spool)`);
  map = Array.from({ length: len }, (_, i) => source.trays[i] ?? -1);
  const unmapped = used.filter((id) => map[id - 1] === undefined || map[id - 1]! < 0);
  if (unmapped.length) throw new Error(`filament ${unmapped.join(", ")} used by plate ${project.plate.plate} has no AMS tray in --ams (position n is filament n)`);
  return map;
}

export interface PrintOptions {
  remoteName: string;
  project: SlicedProject;
  mapping: number[];
  useAms: boolean;
  taskId: string;
  bedLeveling: boolean;
  flowCalibration: boolean;
  vibrationCalibration: boolean;
  layerInspect: boolean;
  timelapse: boolean;
  bedType: string;
}

export function projectFileCommand(o: PrintOptions, sequenceId: string): Json {
  const b = (v: boolean) => (v ? 1 : 0);
  return {
    print: {
      sequence_id: sequenceId,
      command: "project_file",
      param: o.project.plate.gcodePath,
      url: `ftp:///${o.remoteName}`,
      file: o.remoteName,
      md5: o.project.plate.gcodeMd5,
      bed_type: o.bedType,
      timelapse: b(o.timelapse),
      bed_leveling: b(o.bedLeveling),
      flow_cali: b(o.flowCalibration),
      vibration_cali: b(o.vibrationCalibration),
      layer_inspect: b(o.layerInspect),
      use_ams: o.useAms,
      cfg: "0",
      extrude_cali_flag: 0,
      subtask_name: o.remoteName.replace(/\.gcode\.3mf$|\.3mf$/i, ""),
      profile_id: "0",
      project_id: o.taskId,
      subtask_id: o.taskId,
      task_id: o.taskId,
      ams_mapping: o.mapping,
      ams_mapping2: o.mapping.map(amsMapping2),
    },
  };
}

export const controlCommand = (command: "pause" | "resume" | "stop", sequenceId: string): Json => ({ print: { sequence_id: sequenceId, command, param: "" } });
export const pushallCommand = (sequenceId: string): Json => ({ pushing: { sequence_id: sequenceId, command: "pushall", version: 1, push_target: 1 } });
export const versionCommand = (sequenceId: string): Json => ({ info: { sequence_id: sequenceId, command: "get_version" } });

export interface Module { name: string; swVersion?: string; hwVersion?: string; serial?: string }

export class BambuPrinter {
  readonly state: Json = {};
  private listeners = new Set<(msg: Json) => void>();
  private seq = Math.floor(Date.now() % 1_000_000) * 10;

  private constructor(readonly cfg: PrinterFile, private mqtt: MqttClient) {
    mqtt.on("message", (_topic: string, payload: Buffer) => {
      let msg: unknown;
      try { msg = JSON.parse(payload.toString("utf8")); } catch { return; }
      if (!isObj(msg)) return;
      if (isObj(msg.print)) mergeReport(this.state, msg.print);
      for (const l of this.listeners) l(msg);
    });
  }

  static async connect(cfg: PrinterFile, accessCode: string, timeoutMs = 10_000): Promise<BambuPrinter> {
    if (!/^[A-Za-z0-9]{4,32}$/.test(accessCode)) throw new Error("the LAN access code should be the letters and digits shown on the printer (Settings > Network)");
    const { socket } = await connectPinned({ host: cfg.host, port: cfg.mqttPort ?? MQTT_PORT, fingerprint: cfg.mqttFingerprint, timeoutMs });
    const mqtt = await MqttClient.connect(socket, { clientId: `tdp-${process.pid}-${Date.now() % 100000}`, username: LAN_USER, password: accessCode, timeoutMs });
    const p = new BambuPrinter(cfg, mqtt);
    try { await mqtt.subscribe(`device/${cfg.serial}/report`, timeoutMs); } catch (e) { mqtt.close(); throw new Error(`${(e as Error).message}. Check the serial number in the printer file.`); }
    return p;
  }

  get summary(): StatusSummary { return summarize(this.state); }

  nextSequence(): string { this.seq += 1; return String(this.seq); }

  /** Calls `fn` with every report until it returns a value or the time runs out (then undefined). */
  waitFor<T>(fn: (msg: Json) => T | undefined, timeoutMs: number): Promise<T | undefined> {
    return new Promise((resolve) => {
      const done = (v: T | undefined) => { clearTimeout(t); this.listeners.delete(l); this.mqtt.off("close", closed); resolve(v); };
      const l = (msg: Json) => { const v = fn(msg); if (v !== undefined) done(v); };
      const closed = () => done(undefined);
      const t = setTimeout(() => done(undefined), timeoutMs);
      this.listeners.add(l);
      this.mqtt.once("close", closed);
    });
  }

  onReport(fn: (msg: Json) => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  onClose(fn: (e?: Error) => void) { this.mqtt.once("close", fn); }

  send(cmd: Json): Promise<void> { return this.mqtt.publish(`device/${this.cfg.serial}/request`, JSON.stringify(cmd), 1); }

  /** Asks for a full report and waits for it. */
  async refresh(timeoutMs = 10_000): Promise<StatusSummary> {
    const got = this.waitFor((m) => (isObj(m.print) && (m.print as Json).command === "push_status" && "gcode_state" in this.state ? true : undefined), timeoutMs);
    await this.send(pushallCommand(this.nextSequence()));
    if (!(await got)) throw new Error("the printer sent no status report; check it's powered on and the serial number is right");
    return this.summary;
  }

  async version(timeoutMs = 10_000): Promise<Module[]> {
    const seq = this.nextSequence();
    const got = this.waitFor((m) => (isObj(m.info) && (m.info as Json).command === "get_version" && String((m.info as Json).sequence_id) === seq ? (m.info as Json) : undefined), timeoutMs);
    await this.send(versionCommand(seq));
    const info = await got;
    if (!info) throw new Error("the printer didn't answer get_version");
    const mods = Array.isArray(info.module) ? info.module.filter(isObj) : [];
    return mods.map((m) => ({ name: String(m.name ?? ""), swVersion: typeof m.sw_ver === "string" ? m.sw_ver : undefined, hwVersion: typeof m.hw_ver === "string" ? m.hw_ver : undefined, serial: typeof m.sn === "string" ? m.sn : undefined }));
  }

  /**
   * Sends a print or control command and waits for the outcome: an explicit reply, the HMS the
   * printer raises for an unverified command, or (for project_file) the job showing up as started.
   */
  async command(cmd: Json, o: { timeoutMs?: number; startedTask?: string } = {}): Promise<{ outcome: "accepted" | "started" | "rejected" | "no-reply"; reply?: Reply; message: string }> {
    const body = cmd.print as Json;
    const seq = String(body.sequence_id);
    const command = String(body.command);
    const hmsBefore = new Set(this.summary.hms);
    const result = this.waitFor<{ outcome: "accepted" | "started" | "rejected"; reply?: Reply; message: string }>((msg) => {
      const r = replyTo("print", command, seq, msg);
      if (r) return r.accepted ? { outcome: "accepted", reply: r, message: `printer accepted ${command}` } : { outcome: "rejected", reply: r, message: explainRefusal(r) };
      const s = this.summary;
      if (s.hms.includes(HMS_COMMAND_VERIFICATION) && !hmsBefore.has(HMS_COMMAND_VERIFICATION)) return { outcome: "rejected", message: `printer raised HMS ${HMS_COMMAND_VERIFICATION} (MQTT command verification failed). ${DEV_MODE_HINT}` };
      if (o.startedTask && s.taskId === o.startedTask && ["PREPARE", "RUNNING", "SLICING"].includes(s.state)) return { outcome: "started", message: `job ${o.startedTask} is ${s.state}` };
      return undefined;
    }, o.timeoutMs ?? 15_000);
    await this.send(cmd);
    const r = await result;
    return r ?? { outcome: "no-reply", message: `no reply to ${command} within ${Math.round((o.timeoutMs ?? 15_000) / 1000)} s; check the printer's screen` };
  }

  close() { this.mqtt.close(); }
}
