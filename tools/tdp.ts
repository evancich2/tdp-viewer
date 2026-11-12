// tdp: build, sign and verify Technical Data Packages.
//
//   tdp keygen --name "Jane Approver" --roles approver [--days 365] --out keys/jane
//   tdp trust add <trust-store.json> <keys/jane.pub.json>
//   tdp trust revoke <trust-store.json> <keyId>
//   tdp keygen --name "Acme Root" --roles root --out keys/root
//   tdp trust anchor <anchors.json> <keys/root.pub.json>
//   tdp trust sign <trust-store.json> --key <keys/root.key.json> [--days 365] --out <trust-store.signed.json>
//   tdp pack <folder> --out <package.tdp>
//   tdp sign <package.tdp> --key <keys/jane.key.json> --role approver
//   tdp verify <package.tdp> --trust <trust-store.json> [--anchors <anchors.json>]
//   tdp diff <old.tdp> <new.tdp> --trust <trust-store.json> [--anchors <anchors.json>]
//
// Passphrases come from the TDP_PASSPHRASE environment variable or an interactive prompt.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { defaultPolicy } from "../src/core/policy";
import { SignerRole } from "../src/core/schema";
import { diffManifests, formatDiff } from "../src/core/diff";
import { TrustStore } from "../src/core/schema";
import { Anchors, loadAnchors, loadTrustStoreFile, signTrustStore } from "../src/core/truststore";
import { verifyPackage } from "../src/core/verify";
import { addToTrustStore, pack, revokeInTrustStore, sign } from "./commands";
import { KeyRole, MIN_PASSPHRASE, createKey, unlockKey } from "./keys";

const USAGE = readFileSync(new URL(import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l.startsWith("//   tdp"))
  .map((l) => l.slice(5))
  .join("\n");

function die(msg: string): never {
  console.error(msg);
  process.exit(2);
}

async function prompt(question: string): Promise<string> {
  if (!process.stdin.isTTY) die("no terminal for a passphrase prompt; set TDP_PASSPHRASE");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Hide what's typed.
  (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
    if (s.startsWith(question)) process.stdout.write(question);
  };
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write("\n");
  return answer;
}

async function passphrase(confirm: boolean): Promise<string> {
  if (process.env.TDP_PASSPHRASE) return process.env.TDP_PASSPHRASE;
  const first = await prompt("Passphrase: ");
  if (confirm && (await prompt("Repeat passphrase: ")) !== first) die("passphrases don't match");
  return first;
}

function refuseExisting(...paths: string[]) {
  for (const p of paths) if (existsSync(p)) die(`${p} already exists; not overwriting`);
}

const parseRoles = <T extends string>(schema: { safeParse(v: unknown): { success: boolean; data?: T } }, names: string, s?: string): T[] => {
  const parsed = (s ?? "").split(",").filter(Boolean).map((r) => schema.safeParse(r.trim()));
  if (!parsed.length || parsed.some((r) => !r.success)) die(`roles must be a comma-separated list of: ${names}`);
  return parsed.map((r) => r.data!);
};
const signerRoles = (s?: string) => parseRoles<SignerRole>(SignerRole, SignerRole.options.join(", "), s);
const keyRoles = (s?: string) => parseRoles<KeyRole>(KeyRole, `${SignerRole.options.join(", ")}, or root`, s);

/** Trust store (signed or plain), checked against pinned roots if --anchors is given. */
async function trustStoreFromArgs() {
  const anchors = values.anchors ? await loadAnchors(readFileSync(values.anchors, "utf8")) : undefined;
  const loaded = await loadTrustStoreFile(readFileSync(values.trust!, "utf8"), { anchors });
  if (loaded.signedBy) console.log(`trust store serial ${loaded.store.serial}, signed by ${loaded.signedBy.name}, expires ${loaded.store.expires}`);
  return loaded.store;
}

process.on("uncaughtException", (e) => die(`error: ${e.message}`));
process.on("unhandledRejection", (e) => die(`error: ${(e as Error).message}`));

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    name: { type: "string" },
    roles: { type: "string" },
    role: { type: "string" },
    days: { type: "string", default: "365" },
    out: { type: "string" },
    key: { type: "string" },
    trust: { type: "string" },
    anchors: { type: "string" },
  },
});

switch (command) {
  case "keygen": {
    if (!values.name || !values.out) die("usage: tdp keygen --name <name> --roles <roles> [--days 365] --out <basename>");
    const [keyPath, pubPath] = [`${values.out}.key.json`, `${values.out}.pub.json`];
    refuseExisting(keyPath, pubPath);
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) die("--days must be 1 to 3650");
    const pass = await passphrase(true);
    if (pass.length < MIN_PASSPHRASE) die(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const { keyFile, trusted } = await createKey({ name: values.name, roles: keyRoles(values.roles), passphrase: pass, validDays: days });
    writeFileSync(keyPath, JSON.stringify(keyFile, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    writeFileSync(pubPath, JSON.stringify(trusted, null, 2) + "\n", { flag: "wx" });
    const kind = keyFile.roles.includes("root") ? "anchors entry (pin with tdp trust anchor)" : "trust-store entry";
    console.log(`key ${keyFile.keyId}\n  private (encrypted): ${keyPath}\n  ${kind}: ${pubPath}`);
    break;
  }
  case "trust": {
    const [action, storePath, arg] = positionals;
    if (action === "anchor") {
      if (!storePath || !arg) die("usage: tdp trust anchor <anchors.json> <root.pub.json>");
      const root = JSON.parse(readFileSync(arg, "utf8"));
      const roots = existsSync(storePath) ? Anchors.parse(JSON.parse(readFileSync(storePath, "utf8"))).roots : [];
      if (roots.some((r) => r.keyId === root.keyId)) die(`root ${root.keyId} is already pinned`);
      const updated = Anchors.parse({ schema: "tdp-anchors/0.1", roots: [...roots, root] });
      await loadAnchors(JSON.stringify(updated)); // checks key ids
      writeFileSync(storePath, JSON.stringify(updated, null, 2) + "\n");
      console.log(`${storePath}: ${updated.roots.length} pinned roots`);
      break;
    }
    if (action === "sign") {
      if (!storePath || !values.key || !values.out) die("usage: tdp trust sign <store.json> --key <root.key.json> [--days 365] --out <signed.json>");
      const store = TrustStore.parse(JSON.parse(readFileSync(storePath, "utf8")));
      const key = await unlockKey(readFileSync(values.key, "utf8"), await passphrase(false));
      if (!key.roles.includes("root")) die(`${key.name}'s key is not a root key`);
      const serial = (store.serial ?? 0) + 1;
      const signed = await signTrustStore(store, key, { serial, validDays: Number(values.days) });
      writeFileSync(values.out, JSON.stringify(signed, null, 2) + "\n");
      // Remember the serial so the next release is numbered after this one.
      writeFileSync(storePath, JSON.stringify({ ...store, serial }, null, 2) + "\n");
      console.log(`signed ${values.out}: serial ${serial}, ${store.keys.length} keys, by ${key.name}`);
      break;
    }
    if (!storePath || !arg) die("usage: tdp trust add|revoke|anchor|sign ... (run tdp with no arguments for details)");
    const current = existsSync(storePath) ? readFileSync(storePath, "utf8") : null;
    const store =
      action === "add" ? addToTrustStore(current, readFileSync(arg, "utf8"))
      : action === "revoke" && current ? revokeInTrustStore(current, arg)
      : die(`unknown trust action ${action}`);
    writeFileSync(storePath, JSON.stringify(store, null, 2) + "\n");
    console.log(`${storePath}: ${store.keys.length} keys, ${store.keys.filter((k) => k.revoked).length} revoked`);
    break;
  }
  case "pack": {
    const [dir] = positionals;
    if (!dir || !values.out) die("usage: tdp pack <folder> --out <package.tdp>");
    refuseExisting(values.out);
    writeFileSync(values.out, await pack(dir), { flag: "wx" });
    console.log(`wrote ${values.out} (unsigned; next: tdp sign)`);
    break;
  }
  case "sign": {
    const [file] = positionals;
    if (!file || !values.key || !values.role) die("usage: tdp sign <package.tdp> --key <key.json> --role <role>");
    const role = signerRoles(values.role)[0]!;
    const key = await unlockKey(readFileSync(values.key, "utf8"), await passphrase(false));
    if (!key.roles.includes(role)) die(`${key.name}'s key is only for: ${key.roles.join(", ")}`);
    const signed = await sign(new Uint8Array(readFileSync(file)), key, role, defaultPolicy);
    writeFileSync(values.out ?? file, signed);
    console.log(`signed ${values.out ?? file} as ${role} with ${key.name} (${key.keyId})`);
    break;
  }
  case "verify": {
    const [file] = positionals;
    if (!file || !values.trust) die("usage: tdp verify <package.tdp> --trust <trust-store.json>");
    const store = await trustStoreFromArgs();
    const result = await verifyPackage(new Uint8Array(readFileSync(file)), store, defaultPolicy);
    for (const c of result.checks) console.log(`${c.status === "pass" ? "PASS" : "FAIL"}  ${c.id}  ${c.message}`);
    for (const f of result.files.filter((f) => !f.ok)) console.log(`      ${f.path}: ${f.problems.join("; ")}`);
    console.log(result.verdict.toUpperCase());
    process.exit(result.verdict === "trusted" ? 0 : 1);
  }
  case "diff": {
    const [oldFile, newFile] = positionals;
    if (!oldFile || !newFile || !values.trust) die("usage: tdp diff <old.tdp> <new.tdp> --trust <trust-store.json>");
    const store = await trustStoreFromArgs();
    // Only compare packages that verify; a diff against an unverified package would mean trusting it.
    const [a, b] = await Promise.all(
      [oldFile, newFile].map((f) => verifyPackage(new Uint8Array(readFileSync(f)), store, defaultPolicy)),
    );
    for (const [f, r] of [[oldFile, a!], [newFile, b!]] as const)
      if (r.verdict !== "trusted") die(`${f} is not trusted: ${r.checks.filter((c) => c.status === "fail").map((c) => c.message).join("; ")}`);
    console.log(`${a!.manifest!.package.partNumber} rev ${a!.manifest!.package.revision} → rev ${b!.manifest!.package.revision}`);
    console.log(formatDiff(diffManifests(a!.manifest!, b!.manifest!)));
    break;
  }
  default:
    die(`usage:\n${USAGE}`);
}
