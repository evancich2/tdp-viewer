// Hardware-backed signing through an SSH agent (CLI only).
//
// The private key never enters this process: the agent signs. That is how hardware keys plug in:
//   - YubiKey (or other OpenPGP card) holding an Ed25519 key, exposed by gpg-agent's ssh support;
//   - YubiKey PIV with an Ed25519 slot (firmware 5.7+) via ssh-agent and a PKCS#11 module;
//   - or, for testing, a software key loaded with ssh-add.
// Only plain `ssh-ed25519` keys are accepted: their agent signatures are ordinary Ed25519 signatures
// over exactly the bytes we send, so they verify like any other key here. FIDO `sk-ssh-ed25519` keys
// sign a different message (flags and counter) and are refused.
import { connect } from "node:net";
import { sha256Hex, toBase64 } from "../src/core/bytes";
import { keyIdFor, verifyEd25519, type KeyHandle } from "../src/core/signing";

const SSH_AGENTC_REQUEST_IDENTITIES = 11;
const SSH_AGENT_IDENTITIES_ANSWER = 12;
const SSH_AGENTC_SIGN_REQUEST = 13;
const SSH_AGENT_SIGN_RESPONSE = 14;
const MAX_REPLY = 256 * 1024;

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const sshString = (b: Uint8Array) => Buffer.concat([u32(b.length), Buffer.from(b)]);

class Reader {
  constructor(private b: Buffer, private o = 0) {}
  u8() { if (this.o + 1 > this.b.length) throw new Error("agent reply truncated"); return this.b[this.o++]!; }
  u32() { if (this.o + 4 > this.b.length) throw new Error("agent reply truncated"); const v = this.b.readUInt32BE(this.o); this.o += 4; return v; }
  str() { const n = this.u32(); if (n > MAX_REPLY || this.o + n > this.b.length) throw new Error("agent reply truncated"); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
}

/** One request/response exchange with the agent. */
function request(sock: string, type: number, body: Buffer = Buffer.alloc(0)): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const c = connect(sock);
    let buf = Buffer.alloc(0);
    const done = (e?: Error, v?: Buffer) => { c.destroy(); if (e) reject(e); else resolve(v!); };
    c.setTimeout(30_000, () => done(new Error("ssh agent did not answer (touch the token if it needs a touch)")));
    c.on("error", (e) => done(new Error(`can't reach the ssh agent at ${sock}: ${e.message}`)));
    c.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (len > MAX_REPLY) return done(new Error("agent reply too large"));
        if (buf.length >= 4 + len) done(undefined, buf.subarray(4, 4 + len));
      }
    });
    const msg = Buffer.concat([Buffer.from([type]), body]);
    c.write(Buffer.concat([u32(msg.length), msg]));
  });
}

export interface AgentKey {
  keyId: string;
  /** Base64 of the raw 32-byte Ed25519 public key, as trust stores hold it. */
  publicKey: string;
  comment: string;
  blob: Buffer;
}

const agentSocket = (sock?: string) => {
  const s = sock ?? process.env.SSH_AUTH_SOCK;
  if (!s) throw new Error("no SSH agent: set SSH_AUTH_SOCK (for a YubiKey via gpg-agent: gpgconf --list-dirs agent-ssh-socket)");
  return s;
};

/** The agent's plain Ed25519 identities, with the key ids this tool uses. Other key types are skipped. */
export async function agentKeys(sock?: string): Promise<AgentKey[]> {
  const reply = new Reader(await request(agentSocket(sock), SSH_AGENTC_REQUEST_IDENTITIES));
  if (reply.u8() !== SSH_AGENT_IDENTITIES_ANSWER) throw new Error("ssh agent refused to list identities");
  const n = reply.u32();
  if (n > 1000) throw new Error("agent lists too many identities");
  const out: AgentKey[] = [];
  for (let i = 0; i < n; i++) {
    const blob = Buffer.from(reply.str());
    const comment = reply.str().toString("utf8");
    const r = new Reader(blob);
    if (r.str().toString() !== "ssh-ed25519") continue;
    const raw = r.str();
    if (raw.length !== 32) continue;
    const publicKey = toBase64(raw);
    out.push({ keyId: await keyIdFor(publicKey), publicKey, comment, blob });
  }
  return out;
}

/**
 * A signer backed by an agent key, chosen by key id (or a unique comment). Each signature is checked
 * against the public key before it is used, so a misbehaving agent can't slip in a bad one.
 */
export type AgentSigner = Extract<KeyHandle, { sign: unknown }> & { name: string; publicKey: string };

export async function agentSigner(select: string, sock?: string): Promise<AgentSigner> {
  const s = agentSocket(sock);
  const keys = await agentKeys(s);
  const matches = keys.filter((k) => k.keyId === select || k.comment === select);
  if (matches.length !== 1) throw new Error(matches.length ? `"${select}" matches several agent keys; use the key id` : `no ssh-ed25519 key "${select}" in the agent (have: ${keys.map((k) => `${k.keyId} ${k.comment}`).join(", ") || "none"})`);
  const key = matches[0]!;
  return {
    keyId: key.keyId,
    name: key.comment || key.keyId,
    publicKey: key.publicKey,
    sign: async (message: Uint8Array) => {
      const reply = new Reader(await request(s, SSH_AGENTC_SIGN_REQUEST, Buffer.concat([sshString(key.blob), sshString(message), u32(0)])));
      if (reply.u8() !== SSH_AGENT_SIGN_RESPONSE) throw new Error("ssh agent refused to sign (locked, unplugged, or touch not given?)");
      const sigBlob = new Reader(Buffer.from(reply.str()));
      if (sigBlob.str().toString() !== "ssh-ed25519") throw new Error("agent returned a non-Ed25519 signature");
      const sig = toBase64(sigBlob.str());
      if (!(await verifyEd25519(key.publicKey, sig, message))) throw new Error("agent signature does not verify against the key; refusing it");
      return sig;
    },
  };
}

/** Fingerprint shown to people comparing keys out of band. */
export const agentFingerprint = async (k: AgentKey) => (await sha256Hex(k.blob)).slice(0, 32);
