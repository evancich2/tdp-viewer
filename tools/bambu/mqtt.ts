// A minimal MQTT 3.1.1 client: just what talking to a Bambu Lab printer needs (CONNECT,
// SUBSCRIBE, PUBLISH at QoS 0/1, keep-alive). Written here rather than pulled in as a dependency so
// the bridge's network code is small enough to read in one sitting.
import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";

export const MAX_PACKET = 4 * 1024 * 1024; // a pushall report is tens of KB; anything near this is hostile

export const PacketType = { CONNECT: 1, CONNACK: 2, PUBLISH: 3, PUBACK: 4, SUBSCRIBE: 8, SUBACK: 9, PINGREQ: 12, PINGRESP: 13, DISCONNECT: 14 } as const;

export function encodeLength(n: number): Buffer {
  if (n < 0 || n > 268_435_455) throw new Error("MQTT remaining length out of range");
  const out: number[] = [];
  do {
    let b = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return Buffer.from(out);
}

const str = (s: string | Buffer) => {
  const b = typeof s === "string" ? Buffer.from(s, "utf8") : s;
  if (b.length > 0xffff) throw new Error("MQTT string too long");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
};
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const packet = (first: number, body: Buffer) => Buffer.concat([Buffer.from([first]), encodeLength(body.length), body]);

export function encodeConnect(o: { clientId: string; username?: string; password?: string; keepalive: number }): Buffer {
  let flags = 0x02; // clean session
  if (o.username !== undefined) flags |= 0x80;
  if (o.password !== undefined) flags |= 0x40;
  const parts = [str("MQTT"), Buffer.from([4, flags]), u16(o.keepalive), str(o.clientId)];
  if (o.username !== undefined) parts.push(str(o.username));
  if (o.password !== undefined) parts.push(str(o.password));
  return packet(PacketType.CONNECT << 4, Buffer.concat(parts));
}
export const encodeSubscribe = (id: number, topic: string, qos: 0 | 1 = 0) => packet((PacketType.SUBSCRIBE << 4) | 0x02, Buffer.concat([u16(id), str(topic), Buffer.from([qos])]));
export function encodePublish(topic: string, payload: Buffer, qos: 0 | 1 = 0, id = 0): Buffer {
  return packet((PacketType.PUBLISH << 4) | (qos << 1), Buffer.concat([str(topic), qos ? u16(id) : Buffer.alloc(0), payload]));
}
export const encodePuback = (id: number) => packet(PacketType.PUBACK << 4, u16(id));
export const PINGREQ = Buffer.from([PacketType.PINGREQ << 4, 0]);
export const DISCONNECT = Buffer.from([PacketType.DISCONNECT << 4, 0]);

export interface Packet { type: number; flags: number; body: Buffer }

/** Splits a byte stream into MQTT packets. */
export class PacketReader {
  private buf: Buffer = Buffer.alloc(0);
  push(chunk: Buffer): Packet[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: Packet[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      let len = 0, mul = 1, i = 1;
      for (;; i++) {
        if (i > 4) throw new Error("malformed MQTT remaining length");
        if (i >= this.buf.length) return out;
        const b = this.buf[i]!;
        len += (b & 0x7f) * mul;
        mul *= 128;
        if (!(b & 0x80)) break;
      }
      if (len > MAX_PACKET) throw new Error(`MQTT packet of ${len} bytes exceeds the ${MAX_PACKET}-byte limit`);
      const total = i + 1 + len;
      if (this.buf.length < total) break;
      out.push({ type: this.buf[0]! >> 4, flags: this.buf[0]! & 0x0f, body: this.buf.subarray(i + 1, total) });
      this.buf = this.buf.subarray(total);
    }
    return out;
  }
}

export function decodePublish(p: Packet): { topic: string; payload: Buffer; qos: number; id?: number } {
  const qos = (p.flags >> 1) & 3;
  if (p.body.length < 2) throw new Error("short PUBLISH");
  const tl = p.body.readUInt16BE(0);
  if (2 + tl > p.body.length) throw new Error("short PUBLISH topic");
  const topic = p.body.subarray(2, 2 + tl).toString("utf8");
  let off = 2 + tl, id: number | undefined;
  if (qos) { if (off + 2 > p.body.length) throw new Error("short PUBLISH id"); id = p.body.readUInt16BE(off); off += 2; }
  return { topic, payload: p.body.subarray(off), qos, id };
}

const CONNACK_REASONS: Record<number, string> = {
  1: "unacceptable protocol version",
  2: "client identifier rejected",
  3: "server unavailable",
  4: "bad user name or password (check the printer's LAN access code)",
  5: "not authorized",
};

export class MqttError extends Error {}

export class MqttClient extends EventEmitter {
  private reader = new PacketReader();
  private nextId = 1;
  private waiting = new Map<string, { resolve: (p: Packet) => void; reject: (e: Error) => void }>();
  private ping?: NodeJS.Timeout;
  private closed = false;

  private constructor(private sock: Duplex) {
    super();
    sock.on("data", (chunk: Buffer) => {
      let packets: Packet[];
      try { packets = this.reader.push(chunk); } catch (e) { return this.fail(e as Error); }
      for (const p of packets) {
        try { this.handle(p); } catch (e) { return this.fail(new MqttError(`malformed packet from the printer: ${(e as Error).message}`)); }
      }
    });
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new MqttError("connection closed by the printer")));
  }

  /** Sends CONNECT on an already-open (TLS) stream and waits for CONNACK. */
  static async connect(sock: Duplex, o: { clientId: string; username?: string; password?: string; keepalive?: number; timeoutMs?: number }): Promise<MqttClient> {
    const c = new MqttClient(sock);
    const keepalive = o.keepalive ?? 60;
    const ack = c.expect("connack", o.timeoutMs ?? 10_000);
    sock.write(encodeConnect({ ...o, keepalive }));
    const p = await ack;
    if (p.body.length < 2) throw new MqttError("short CONNACK");
    const rc = p.body[1]!;
    if (rc !== 0) { c.close(); throw new MqttError(`printer refused the MQTT connection: ${CONNACK_REASONS[rc] ?? `code ${rc}`}`); }
    c.ping = setInterval(() => { if (!c.closed) sock.write(PINGREQ); }, (keepalive * 1000) / 2);
    c.ping.unref();
    return c;
  }

  private expect(key: string, timeoutMs: number): Promise<Packet> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(key); reject(new MqttError(`timed out waiting for ${key.split(":")[0]!.toUpperCase()}`)); }, timeoutMs);
      this.waiting.set(key, { resolve: (p) => { clearTimeout(t); resolve(p); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }

  private settle(key: string, p: Packet) {
    const w = this.waiting.get(key);
    if (w) { this.waiting.delete(key); w.resolve(p); }
  }

  private handle(p: Packet) {
    switch (p.type) {
      case PacketType.CONNACK: return this.settle("connack", p);
      case PacketType.SUBACK: return this.settle(`suback:${p.body.readUInt16BE(0)}`, p);
      case PacketType.PUBACK: return this.settle(`puback:${p.body.readUInt16BE(0)}`, p);
      case PacketType.PINGRESP: return;
      case PacketType.PUBLISH: {
        let m;
        try { m = decodePublish(p); } catch (e) { return this.fail(e as Error); }
        if (m.qos === 1 && m.id !== undefined) this.sock.write(encodePuback(m.id));
        this.emit("message", m.topic, m.payload);
        return;
      }
      default: return; // ignore anything else
    }
  }

  private fail(e: Error) {
    if (this.closed) return;
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
    this.sock.destroy();
    this.emit("close", e);
  }

  private id() { const id = this.nextId; this.nextId = (this.nextId % 0xffff) + 1; return id; }

  async subscribe(topic: string, timeoutMs = 10_000): Promise<void> {
    const id = this.id();
    const ack = this.expect(`suback:${id}`, timeoutMs);
    this.sock.write(encodeSubscribe(id, topic));
    const p = await ack;
    if (p.body.length < 3 || p.body[2] === 0x80) throw new MqttError(`printer refused the subscription to ${topic}`);
  }

  /** QoS 1 waits until the printer has acknowledged receipt (not that it accepted the command). */
  async publish(topic: string, payload: string | Buffer, qos: 0 | 1 = 1, timeoutMs = 10_000): Promise<void> {
    if (this.closed) throw new MqttError("not connected");
    const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
    if (qos === 0) { this.sock.write(encodePublish(topic, body)); return; }
    const id = this.id();
    const ack = this.expect(`puback:${id}`, timeoutMs);
    this.sock.write(encodePublish(topic, body, 1, id));
    await ack;
  }

  close() {
    if (this.closed) return;
    try { this.sock.write(DISCONNECT); this.sock.end(); } catch { /* already gone */ }
    this.closed = true;
    if (this.ping) clearInterval(this.ping);
    for (const w of this.waiting.values()) w.reject(new MqttError("connection closed"));
    this.waiting.clear();
    this.emit("close");
  }
}
