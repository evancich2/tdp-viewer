// Hardware-key path, exercised with a software key in a private ssh-agent started for this test.
// (A YubiKey via gpg-agent or PIV presents the same protocol; it can't be tested without one.)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPackage, defaultPolicy, generateKeyPair, verifyEd25519, verifyPackage, type TrustStore } from "../src/core";
import { utf8 } from "../src/core/bytes";
import { agentKeys, agentSigner } from "../tools/agent";
import { sampleContents } from "../tools/sample-data";

let dir: string;
let sock: string;
let agent: ChildProcess;
let available = true;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tdp-agent-"));
  sock = join(dir, "agent.sock");
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test-token-key", "-f", join(dir, "id")]);
    execFileSync("ssh-keygen", ["-q", "-t", "ecdsa", "-N", "", "-C", "not-ed25519", "-f", join(dir, "ec")]);
    agent = spawn("ssh-agent", ["-D", "-a", sock], { stdio: "ignore" });
    for (let i = 0; i < 50; i++) { try { execFileSync("ssh-add", ["-l"], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: "ignore" }); break; } catch (e) { if ((e as { status?: number }).status === 1) break; await new Promise((r) => setTimeout(r, 100)); } }
    for (const k of ["id", "ec"]) execFileSync("ssh-add", ["-q", join(dir, k)], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: "ignore" });
  } catch {
    available = false;
  }
}, 20_000);

afterAll(() => { agent?.kill(); rmSync(dir, { recursive: true, force: true }); });

describe("ssh-agent signer", () => {
  it("lists only plain Ed25519 identities, with this tool's key ids", async () => {
    if (!available) return console.warn("ssh-agent/ssh-keygen unavailable; skipped");
    const keys = await agentKeys(sock);
    expect(keys.map((k) => k.comment)).toEqual(["test-token-key"]);
    expect(keys[0]!.keyId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("signs through the agent; signatures verify as ordinary Ed25519 and sign real packages", async () => {
    if (!available) return;
    const s = await agentSigner("test-token-key", sock);
    const msg = utf8.encode("tdp agent test");
    expect(await verifyEd25519(s.publicKey, await s.sign(msg), msg)).toBe(true);
    const approver = await generateKeyPair();
    const now = new Date();
    const entry = (keyId: string, publicKey: string, role: "author" | "approver") => ({ keyId, name: role, publicKey, roles: [role], notBefore: new Date(now.getTime() - 86_400_000).toISOString(), notAfter: new Date(now.getTime() + 86_400_000).toISOString(), revoked: false });
    const store: TrustStore = { schema: "tdp-truststore/0.1", keys: [entry(s.keyId, s.publicKey, "author"), entry(approver.keyId, approver.publicKey, "approver")] };
    const { inputs, bom } = sampleContents();
    const tdp = await buildPackage({ id: "8f2d1c3a-6b4e-4f0a-9c1d-2e3f4a5b6c7d", title: "Agent", partNumber: "SMP-1000", revision: "B", created: now.toISOString() }, inputs, bom, [{ ...s, role: "author" }, { ...approver, role: "approver" }], now);
    expect((await verifyPackage(tdp, store, defaultPolicy, now)).verdict).toBe("trusted");
  });

  it("refuses unknown keys, non-Ed25519 keys and a missing agent", async () => {
    if (!available) return;
    await expect(agentSigner("not-ed25519", sock)).rejects.toThrow(/no ssh-ed25519 key/);
    await expect(agentSigner("nope", sock)).rejects.toThrow(/no ssh-ed25519 key/);
    await expect(agentKeys(join(dir, "missing.sock"))).rejects.toThrow(/can't reach the ssh agent/);
  });
});
