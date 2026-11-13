// A simulated Bambu Lab H2C for testing the printer bridge: an MQTT 3.1.1 broker over TLS and an
// implicit-FTPS server, both with a self-signed certificate whose CN is the serial (as on the real
// printer). Its MQTT parsing is written independently of tools/bambu/mqtt.ts so a codec bug can't
// hide by being mirrored on both sides. Message shapes follow the community documentation the
// bridge was written from; this shows the bridge speaks that dialect, not that the printer does.
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { unzipSync } from "fflate";

export const OPENSSL = (() => { for (const bin of ["/opt/local/bin/openssl", "/usr/bin/openssl", "openssl"]) { try { execFileSync(bin, ["version"], { stdio: "ignore" }); return bin; } catch { /* next */ } } return null; })();

export function makeCert(cn: string): { key: Buffer; cert: Buffer; fingerprint: string } {
  if (!OPENSSL) throw new Error("openssl not available");
  const dir = mkdtempSync(join(tmpdir(), "fake-h2c-"));
  execFileSync(OPENSSL, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k"), "-out", join(dir, "c"), "-days", "2", "-subj", `/CN=${cn}/O=Fake Printer (test)`], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "c"));
  const fp = new X509Certificate(cert).fingerprint256;
  return { key: readFileSync(join(dir, "k")), cert, fingerprint: fp };
}

type Json = Record<string, any>;

export interface FakeOptions {
  serial: string;
  accessCode: string;
  firmware?: string;
  /** Off: print/control commands are refused the way `refusal` says. */
  devMode?: boolean;
  refusal?: "err_code" | "hms" | "silent";
  initialState?: string;
  /** Skip the 226 after STOR (some printers do). */
  skip226?: boolean;
  /** Refuse FTPS data connections that don't resume the control session (as the printer does). */
  requireSessionReuse?: boolean;
  maxTlsVersion?: tls.SecureVersion;
  /** Run a started job to FINISH (or FAILED with an HMS) by itself. */
  autoRun?: "finish" | "fail" | false;
  stepMs?: number;
  /** Send a hostile oversized MQTT packet header after CONNACK. */
  hostileOversize?: boolean;
  certs?: { key: Buffer; cert: Buffer; fingerprint: string };
  /** Address advertised in PASV replies; by default a decoy the client must ignore. */
  pasvAddress?: string;
}

export interface FakeH2C {
  mqttPort: number;
  ftpsPort: number;
  fingerprint: string;
  files: Map<string, Buffer>;
  requests: Json[];
  connects: { username?: string; password?: string; clientId: string }[];
  dataSessionReused: boolean[];
  state: Json;
  close(): Promise<void>;
}

function remainingLength(buf: Buffer, start: number): { value: number; bytes: number } | null {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    if (start + i >= buf.length) return null;
    const b = buf[start + i]!;
    value |= (b & 127) << (7 * i);
    if ((b & 128) === 0) return { value, bytes: i + 1 };
  }
  throw new Error("bad length");
}
function rl(n: number): Buffer {
  const out: number[] = [];
  do { let b = n & 127; n >>>= 7; if (n) b |= 128; out.push(b); } while (n);
  return Buffer.from(out);
}
function mqttString(b: Buffer, off: number): [string, number] {
  const n = (b[off]! << 8) | b[off + 1]!;
  return [b.subarray(off + 2, off + 2 + n).toString(), off + 2 + n];
}
function publishPacket(topic: string, payload: string): Buffer {
  const t = Buffer.from(topic), p = Buffer.from(payload);
  const body = Buffer.concat([Buffer.from([t.length >> 8, t.length & 255]), t, p]);
  return Buffer.concat([Buffer.from([0x30]), rl(body.length), body]);
}

export async function startFakeH2C(o: FakeOptions): Promise<FakeH2C> {
  const certs = o.certs ?? makeCert(o.serial);
  const ticketKeys = randomBytes(48);
  const tlsOpts: tls.TlsOptions = { key: certs.key, cert: certs.cert, ticketKeys, maxVersion: o.maxTlsVersion, minVersion: "TLSv1.2" };
  const files = new Map<string, Buffer>();
  const requests: Json[] = [];
  const connects: FakeH2C["connects"] = [];
  const dataSessionReused: boolean[] = [];
  const state: Json = {
    command: "push_status", gcode_state: o.initialState ?? "IDLE", mc_percent: 0, mc_remaining_time: 0, layer_num: 0, total_layer_num: 0,
    subtask_name: "", task_id: "0", nozzle_temper: 25, bed_temper: 24, chamber_temper: 26, print_error: 0, hms: [], wifi_signal: "-48dBm",
  };
  const subscribers = new Set<tls.TLSSocket>();
  const sockets = new Set<tls.TLSSocket>();
  const track = (s: tls.TLSSocket) => { sockets.add(s); s.on("close", () => sockets.delete(s)); };
  const timers = new Set<NodeJS.Timeout>();
  const later = (ms: number, fn: () => void) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };
  const step = o.stepMs ?? 30;
  const report = (patch: Json) => {
    Object.assign(state, patch);
    const msg = JSON.stringify({ print: { command: "push_status", sequence_id: "0", ...patch } });
    for (const s of subscribers) s.write(publishPacket(`device/${o.serial}/report`, msg));
  };
  const reply = (section: string, body: Json) => {
    const msg = JSON.stringify({ [section]: body });
    for (const s of subscribers) s.write(publishPacket(`device/${o.serial}/report`, msg));
  };
  const refuse = (cmd: Json) => {
    if (o.refusal === "silent") return;
    if (o.refusal === "hms") return report({ hms: [{ attr: 0x05000500, code: 0x00010007 }] });
    reply("print", { command: cmd.command, sequence_id: cmd.sequence_id, result: "fail", err_code: 0x05024008, reason: "permission denied" });
  };

  const handleRequest = (req: Json) => {
    requests.push(req);
    if (req.pushing?.command === "pushall") {
      const msg = JSON.stringify({ print: { ...state, command: "push_status", sequence_id: req.pushing.sequence_id } });
      for (const s of subscribers) s.write(publishPacket(`device/${o.serial}/report`, msg));
      return;
    }
    if (req.info?.command === "get_version") {
      return reply("info", { command: "get_version", sequence_id: req.info.sequence_id, module: [
        { name: "ota", sw_ver: o.firmware ?? "01.03.00.00", hw_ver: "", sn: o.serial },
        { name: "mc", sw_ver: "00.00.31.05", hw_ver: "MC09", sn: "MCFAKE" },
        { name: "ams/0", sw_ver: "00.00.07.89", hw_ver: "AMS08", sn: "AMSFAKE" },
      ] });
    }
    const p = req.print;
    if (!p) return;
    if (!o.devMode) return refuse(p);
    if (p.command === "project_file") {
      const file = files.get(String(p.url).replace(/^ftp:\/\/\//, ""));
      let md5ok = false;
      if (file) {
        try { const g = unzipSync(new Uint8Array(file), { filter: (f) => f.name === p.param })[String(p.param)]; md5ok = !!g && createHash("md5").update(g).digest("hex") === p.md5; } catch { md5ok = false; }
      }
      if (!file || !md5ok) return reply("print", { command: "project_file", sequence_id: p.sequence_id, result: "fail", err_code: 0x0500400e, reason: file ? "md5 mismatch" : "file not found" });
      reply("print", { command: "project_file", sequence_id: p.sequence_id, result: "success", err_code: 0 });
      later(step, () => report({ gcode_state: "PREPARE", task_id: p.task_id, subtask_name: p.subtask_name, mc_percent: 0, total_layer_num: 40 }));
      later(step * 2, () => report({ gcode_state: "RUNNING", mc_percent: 1, layer_num: 1, mc_remaining_time: 42 }));
      if (o.autoRun === "finish") {
        later(step * 3, () => report({ mc_percent: 50, layer_num: 20, mc_remaining_time: 21 }));
        later(step * 4, () => report({ gcode_state: "FINISH", mc_percent: 100, layer_num: 40, mc_remaining_time: 0 }));
      } else if (o.autoRun === "fail") {
        later(step * 3, () => report({ gcode_state: "FAILED", print_error: 0x0300400c, hms: [{ attr: 0x03000300, code: 0x00010004 }] }));
      }
      return;
    }
    if (["pause", "resume", "stop"].includes(p.command)) {
      reply("print", { command: p.command, sequence_id: p.sequence_id, result: "success", err_code: 0 });
      const next = p.command === "pause" ? "PAUSE" : p.command === "resume" ? "RUNNING" : "IDLE";
      later(step, () => report({ gcode_state: next }));
    }
  };

  // ---- MQTT ----
  const mqtt = tls.createServer(tlsOpts, (sock) => {
    track(sock);
    let buf: Buffer = Buffer.alloc(0);
    let authed = false;
    sock.on("error", () => {});
    sock.on("close", () => subscribers.delete(sock));
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const len = remainingLength(buf, 1);
        if (!len) return;
        const total = 1 + len.bytes + len.value;
        if (buf.length < total) return;
        const type = buf[0]! >> 4, flags = buf[0]! & 15;
        const body = buf.subarray(1 + len.bytes, total);
        buf = buf.subarray(total);
        if (type === 1) {
          let off = 0;
          const [proto, o1] = mqttString(body, off); off = o1;
          const level = body[off++]!, cflags = body[off++]!;
          off += 2; // keepalive
          const [clientId, o2] = mqttString(body, off); off = o2;
          let username: string | undefined, password: string | undefined;
          if (cflags & 0x80) { [username, off] = mqttString(body, off); }
          if (cflags & 0x40) { [password, off] = mqttString(body, off); }
          connects.push({ clientId, username, password });
          const ok = proto === "MQTT" && level === 4 && username === "bblp" && password === o.accessCode;
          sock.write(Buffer.from([0x20, 2, 0, ok ? 0 : 5]));
          if (!ok) { sock.end(); return; }
          authed = true;
          if (o.hostileOversize) sock.write(Buffer.from([0x30, 0xff, 0xff, 0xff, 0x7f]));
        } else if (!authed) { sock.destroy(); return; }
        else if (type === 8) {
          const id = body.readUInt16BE(0);
          const [topic] = mqttString(body, 2);
          const ok = topic === `device/${o.serial}/report`;
          if (ok) subscribers.add(sock);
          sock.write(Buffer.from([0x90, 3, id >> 8, id & 255, ok ? 0 : 0x80]));
        } else if (type === 3) {
          const qos = (flags >> 1) & 3;
          const [topic, off] = mqttString(body, 0);
          let payloadAt = off;
          if (qos) { const id = body.readUInt16BE(off); payloadAt += 2; sock.write(Buffer.from([0x40, 2, id >> 8, id & 255])); }
          if (topic !== `device/${o.serial}/request`) continue;
          try { handleRequest(JSON.parse(body.subarray(payloadAt).toString())); } catch { /* ignore junk */ }
        } else if (type === 12) sock.write(Buffer.from([0xd0, 0]));
        else if (type === 14) sock.end();
      }
    });
  });

  // ---- FTPS ----
  const ftps = tls.createServer(tlsOpts, (sock) => {
    track(sock);
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    const say = (l: string) => sock.write(`${l}\r\n`);
    let user = "", authed = false, pasv: tls.Server | undefined;
    let dataSock: Promise<tls.TLSSocket> | undefined;
    say("220 Welcome to the fake printer's FTP");
    let pending = "";
    const openPasv = () => new Promise<number>((resolve) => {
      pasv?.close();
      const server = tls.createServer(tlsOpts);
      pasv = server;
      dataSock = new Promise((res) => server.once("secureConnection", (s) => { track(s); s.on("error", () => {}); dataSessionReused.push(s.isSessionReused()); server.close(); res(s); }));
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    const handle = async (line: string) => {
      const [verb, ...args] = line.split(" ");
      const arg = args.join(" ");
      const v = verb!.toUpperCase();
      if (v === "USER") { user = arg; return say("331 Password required"); }
      if (v === "PASS") { authed = user === "bblp" && arg === o.accessCode; return say(authed ? "230 Login successful." : "530 Login incorrect."); }
      if (!authed) return say("530 Please login with USER and PASS.");
      if (v === "PBSZ") return say("200 PBSZ set to 0.");
      if (v === "PROT") return say("200 PROT now Private.");
      if (v === "TYPE") return say("200 Switching to Binary mode.");
      if (v === "PASV") { const port = await openPasv(); return say(`227 Entering Passive Mode (${o.pasvAddress ?? "10,9,8,7"},${port >> 8},${port & 255}).`); }
      if (v === "SIZE") { const f = files.get(arg); return say(f ? `213 ${f.length}` : "550 Could not get file size."); }
      if (v === "DELE") { return say(files.delete(arg) ? "250 Delete operation successful." : "550 Delete operation failed."); }
      if (v === "STOR" || v === "NLST") {
        if (!dataSock) return say("425 Use PORT or PASV first.");
        say("150 Ok to send data.");
        const d = await dataSock;
        dataSock = undefined;
        if (o.requireSessionReuse !== false && !dataSessionReused.at(-1)) { d.destroy(); return say("522 SSL connection failed: session reuse required"); }
        if (v === "NLST") { d.end([...files.keys()].join("\r\n") + "\r\n"); d.on("close", () => say("226 Directory send OK.")); return; }
        const chunks: Buffer[] = [];
        d.on("data", (c: Buffer) => chunks.push(c));
        d.on("end", () => { files.set(arg, Buffer.concat(chunks)); d.end(); if (!o.skip226) say("226 Transfer complete."); });
        return;
      }
      if (v === "QUIT") { say("221 Goodbye."); return sock.end(); }
      say("502 Command not implemented.");
    };
    let chain = Promise.resolve();
    sock.on("data", (d: string) => {
      pending += d;
      let i: number;
      while ((i = pending.indexOf("\r\n")) >= 0) {
        const line = pending.slice(0, i);
        pending = pending.slice(i + 2);
        chain = chain.then(async () => { await handle(line); });
      }
    });
    sock.on("close", () => pasv?.close());
  });

  const listen = (s: tls.Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as { port: number }).port)));
  const [mqttPort, ftpsPort] = [await listen(mqtt), await listen(ftps)];
  return {
    mqttPort, ftpsPort, fingerprint: certs.fingerprint, files, requests, connects, dataSessionReused, state,
    close: async () => {
      for (const t of timers) clearTimeout(t);
      for (const s of sockets) s.destroy();
      await Promise.all([mqtt, ftps].map((s) => new Promise((r) => s.close(() => r(undefined)))));
    },
  };
}
