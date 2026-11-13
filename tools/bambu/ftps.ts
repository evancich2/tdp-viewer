// A minimal implicit-FTPS client (TLS from the first byte, port 990): enough to put a sliced
// .gcode.3mf on a Bambu Lab printer and check it arrived. The printer's FTP server requires every
// data connection to resume the control connection's TLS session, and both must present the pinned
// certificate.
import type tls from "node:tls";
import { connectPinned } from "./pinned";

export interface Reply { code: number; text: string }
export class FtpError extends Error {
  constructor(message: string, readonly reply?: Reply) { super(message); }
}

/** File names we're willing to create on the printer: plain names, no paths or control characters. */
export function checkRemoteName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(name) || name.includes("..")) throw new FtpError(`unsafe file name for the printer: ${JSON.stringify(name)} (letters, digits, . _ - only)`);
  return name;
}

export class FtpsClient {
  private buf = "";
  private replies: Reply[] = [];
  private waiters: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  private partial: string[] = [];
  private session?: Buffer;
  private dead?: Error;

  private constructor(private sock: tls.TLSSocket, private host: string, private fingerprint: string, private timeoutMs: number) {
    sock.setEncoding("utf8");
    sock.on("session", (s: Buffer) => { this.session = s; });
    sock.on("data", (d: string) => this.onData(d));
    sock.on("error", (e) => this.kill(new FtpError(`control connection: ${e.message}`)));
    sock.on("close", () => this.kill(new FtpError("control connection closed by the printer")));
  }

  static async connect(o: { host: string; port?: number; fingerprint: string; user: string; password: string; timeoutMs?: number }): Promise<FtpsClient> {
    const { socket } = await connectPinned({ host: o.host, port: o.port ?? 990, fingerprint: o.fingerprint, timeoutMs: o.timeoutMs });
    const c = new FtpsClient(socket, o.host, o.fingerprint, o.timeoutMs ?? 15_000);
    try {
      await c.expect(await c.read(), [220], "greeting");
      const u = await c.cmd(`USER ${o.user}`);
      if (u.code === 331) await c.expect(await c.cmd(`PASS ${o.password}`), [230], "login (check the LAN access code)");
      else c.expect(u, [230], "login");
      await c.expect(await c.cmd("PBSZ 0"), [200], "PBSZ");
      await c.expect(await c.cmd("PROT P"), [200], "PROT P");
      await c.expect(await c.cmd("TYPE I"), [200], "TYPE I");
    } catch (e) { c.close(); throw e; }
    return c;
  }

  private onData(d: string) {
    this.buf += d;
    if (this.buf.length > 1_000_000) return this.kill(new FtpError("oversized reply from the printer"));
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl).replace(/\r$/, "");
      this.buf = this.buf.slice(nl + 1);
      this.partial.push(line);
      const first = this.partial[0]!;
      const m = /^(\d{3})([ -])/.exec(first);
      if (!m) { this.partial = []; continue; } // stray line
      // A reply ends on a line starting with its code and a space.
      const done = m[2] === " " || (this.partial.length > 1 && line.startsWith(`${m[1]} `));
      if (done) {
        const r = { code: Number(m[1]), text: this.partial.map((l) => l.replace(/^\d{3}[ -]?/, "")).join("\n") };
        this.partial = [];
        const w = this.waiters.shift();
        if (w) w.resolve(r); else this.replies.push(r);
      }
    }
  }

  private kill(e: Error) {
    if (this.dead) return;
    this.dead = e;
    for (const w of this.waiters) w.reject(e);
    this.waiters = [];
  }

  read(timeoutMs = this.timeoutMs): Promise<Reply> {
    const r = this.replies.shift();
    if (r) return Promise.resolve(r);
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const w = {
        resolve: (x: Reply) => { clearTimeout(t); resolve(x); },
        reject: (e: Error) => { clearTimeout(t); reject(e); },
      };
      const t = setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new FtpError("timed out waiting for the printer's reply")); }, timeoutMs);
      this.waiters.push(w);
    });
  }

  cmd(line: string): Promise<Reply> {
    if (/[\r\n]/.test(line)) return Promise.reject(new FtpError("control characters in an FTP command"));
    if (this.dead) return Promise.reject(this.dead);
    this.sock.write(`${line}\r\n`);
    return this.read();
  }

  private expect(r: Reply, codes: number[], what: string): Reply {
    if (!codes.includes(r.code)) throw new FtpError(`${what} failed: ${r.code} ${r.text}`, r);
    return r;
  }

  private async passive(): Promise<number> {
    const r = this.expect(await this.cmd("PASV"), [227], "PASV");
    const m = /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(r.text);
    if (!m) throw new FtpError(`unreadable PASV reply: ${r.text}`);
    const port = Number(m[5]) * 256 + Number(m[6]);
    if (port < 1 || port > 65535) throw new FtpError(`bad PASV port ${port}`);
    // Connect to the host we already trust, never to the address in the reply.
    return port;
  }

  /** Runs one data-channel command: PASV, open the pinned TLS data connection, send `line`. */
  private async transfer(line: string, upload?: Uint8Array): Promise<{ data: Buffer; final: Reply | null }> {
    const port = await this.passive();
    const session = this.session ?? this.sock.getSession();
    let dataSock: tls.TLSSocket | undefined;
    const opened = connectPinned({ host: this.host, port, fingerprint: this.fingerprint, session, timeoutMs: this.timeoutMs }, (s) => { dataSock = s; });
    opened.catch(() => undefined);
    const pre = await this.cmd(line);
    if (pre.code !== 150 && pre.code !== 125) {
      dataSock?.destroy();
      throw new FtpError(`${line.split(" ")[0]} refused: ${pre.code} ${pre.text}`, pre);
    }
    const { socket } = await opened;
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      socket.on("data", (c: Buffer) => chunks.push(c));
      socket.on("error", (e) => reject(new FtpError(`data connection: ${e.message}`)));
      socket.on("close", () => resolve());
      if (upload) socket.end(Buffer.from(upload.buffer, upload.byteOffset, upload.byteLength));
      else socket.on("end", () => socket.end());
    });
    // Some printers never send the closing 226 for uploads; the caller confirms by size instead.
    const final = await this.read(upload ? Math.min(this.timeoutMs, 10_000) : this.timeoutMs).catch((e) => { if (upload) return null; throw e; });
    if (final && (final.code < 200 || final.code >= 300)) throw new FtpError(`${line.split(" ")[0]} failed: ${final.code} ${final.text}`, final);
    return { data: Buffer.concat(chunks), final };
  }

  /** Size in bytes, or null if the file doesn't exist. */
  async size(name: string): Promise<number | null> {
    const r = await this.cmd(`SIZE ${checkRemoteName(name)}`);
    if (r.code === 213) return Number(r.text.trim());
    if (r.code === 550) return null;
    throw new FtpError(`SIZE failed: ${r.code} ${r.text}`, r);
  }

  /** Uploads a new file (never overwrites) and confirms the printer holds the full size. */
  async upload(name: string, bytes: Uint8Array): Promise<{ confirmedBy: "226" | "size" }> {
    checkRemoteName(name);
    if ((await this.size(name)) !== null) throw new FtpError(`${name} already exists on the printer; choose another name or delete it first`);
    const { final } = await this.transfer(`STOR ${name}`, bytes);
    const got = await this.size(name);
    if (got !== bytes.byteLength) throw new FtpError(`upload incomplete: printer holds ${got ?? "nothing"} of ${bytes.byteLength} bytes`);
    return { confirmedBy: final ? "226" : "size" };
  }

  async list(): Promise<string[]> {
    const { data } = await this.transfer("NLST");
    return data.toString("utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }

  async remove(name: string): Promise<void> {
    this.expect(await this.cmd(`DELE ${checkRemoteName(name)}`), [250], "DELE");
  }

  close() {
    if (!this.dead) { try { this.sock.write("QUIT\r\n"); } catch { /* gone */ } }
    this.sock.end();
    this.kill(new FtpError("closed"));
  }
}
