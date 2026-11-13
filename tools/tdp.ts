// tdp: build, sign and verify Technical Data Packages.
//
//   tdp keygen --name "Jane Approver" --roles approver --org "Acme" [--cage 1ABC2] [--days 365] --out keys/jane
//   tdp keygen --name "Oli Operator" --org "Print Cell" --out keys/oli        (no --roles: signs workflow records only)
//   tdp trust add <trust-store.json> <keys/jane.pub.json>
//   tdp trust revoke <trust-store.json> <keyId>
//   tdp keygen --name "Acme Root" --roles root --out keys/root
//   tdp trust anchor <anchors.json> <keys/root.pub.json>
//   tdp trust sign <trust-store.json> --key <keys/root.key.json> [--days 365] --out <trust-store.signed.json>
//   tdp pack <folder> --out <package.tdp>
//   tdp sign <package.tdp> --key <keys/jane.key.json> --role approver
//   tdp verify <package.tdp> --trust <trust-store.json> [--anchors <anchors.json>]
//   tdp diff <old.tdp> <new.tdp> --trust <trust-store.json> [--anchors <anchors.json>]
//   tdp authority sign <authority.json> --key <root.key.json> --out <authority.signed.json>
//   tdp record new <package.tdp> --out <ledger.json> [--item ID@REV] <context>
//   tdp record add <ledger.json> --package <package.tdp> --key <key.json> --action <transition> --role <workflow-role> --outcome <outcome> --reason "..." --data <data.json> [--serial SN] [--lot L] [--evidence ID=TAG=PATH ...] [--synthetic] <context>
//   tdp record verify <ledger.json> --package <package.tdp> [--checkpoint <checkpoint.json>] <context>
//   tdp record checkpoint <ledger.json> --package <package.tdp> --out <checkpoint.json> <context>
//   tdp evidence export <ledger.json> --package <package.tdp> --out <bundle.json> [--key <key.json>] [--proposals <p.json> --acks <a.json>] <context>
//   tdp evidence verify <bundle.signed.json> --trust <trust-store.json> [--anchors <anchors.json>]
//   tdp sync export <ledger.json> --package <package.tdp> --recipe <recipe.json> --fixture <fixture.json> --out <proposals.json> [--known-proposals <p.json> --known-acks <a.json>] <context>
//   tdp sync apply-fixture <proposals.json> --fixture <fixture.json> --out <acks.json> [--key <ack-key.json>]   (local fixture adapter; updates the fixture file)
//   tdp sync import <proposals.json> <acks.json> [--trust <trust-store> --authority <authority> [--anchors <anchors.json>]]   (with trust: acks must be signed)
//   tdp sync check-publication --package <package.tdp> (--fixture <fixture.json> | --onshape) <context>
//   tdp source onshape-ref --id <source-id> --document <did> --version <vid> --element <eid> --revision <rev> [--part-number <pn>] [--out <ref.json>]
//                          (Onshape commands read ONSHAPE_ACCESS_KEY / ONSHAPE_SECRET_KEY from the environment; read-only)
//
//   <context> = --trust <trust-store> --authority <authority> --process <process.json> [--anchors <anchors.json>] [--evidence-dir <dir>] [--successor <newer.tdp> ...] [--at <ISO time>]
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
import { signConfig, AuthorityConfig, loadAuthority } from "../src/core/authority";
import { signEvidenceBundle, verifySignedEvidence } from "../src/core/evidence";
import { TransitionDenied as RecordDenied, verifyLedger } from "../src/core/records";
import { utf8 } from "../src/core/bytes";
import * as wf from "./workflow-commands";
import { OnshapeClient, OnshapeReadAdapter, credentialsFromEnv } from "./onshape";
import { KeyRole, MIN_PASSPHRASE, createKey, unlockKey } from "./keys";

const USAGE = readFileSync(new URL(import.meta.url), "utf8")
  .split("\n")
  .filter((l) => /^\/\/   (tdp|<context>)/.test(l))
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
    org: { type: "string" },
    cage: { type: "string" },
    package: { type: "string" },
    authority: { type: "string" },
    process: { type: "string" },
    "evidence-dir": { type: "string" },
    at: { type: "string" },
    item: { type: "string" },
    action: { type: "string" },
    outcome: { type: "string" },
    reason: { type: "string" },
    data: { type: "string" },
    serial: { type: "string" },
    lot: { type: "string" },
    evidence: { type: "string", multiple: true },
    synthetic: { type: "boolean", default: false },
    checkpoint: { type: "string" },
    recipe: { type: "string" },
    fixture: { type: "string" },
    proposals: { type: "string" },
    acks: { type: "string" },
    "known-proposals": { type: "string" },
    "known-acks": { type: "string" },
    successor: { type: "string", multiple: true },
    onshape: { type: "boolean", default: false },
    id: { type: "string" },
    document: { type: "string" },
    version: { type: "string" },
    element: { type: "string" },
    revision: { type: "string" },
    "part-number": { type: "string" },
  },
});

/** Everything a workflow decision depends on, verified. */
async function workflowContext() {
  if (!values.package || !values.trust || !values.authority || !values.process)
    die("needs --package, --trust, --authority and --process (plus --anchors for signed files, --evidence-dir to hash-check evidence)");
  const c = await wf.loadContext({ package: values.package, trust: values.trust, authority: values.authority, process: values.process, anchors: values.anchors, evidenceDir: values["evidence-dir"], at: values.at, successors: values.successor });
  for (const n of c.notes) console.log(n);
  return c;
}
const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v, null, 2) + "\n");

switch (command) {
  case "keygen": {
    if (!values.name || !values.out) die("usage: tdp keygen --name <name> --roles <roles> [--days 365] --out <basename>");
    const [keyPath, pubPath] = [`${values.out}.key.json`, `${values.out}.pub.json`];
    refuseExisting(keyPath, pubPath);
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 3650) die("--days must be 1 to 3650");
    const pass = await passphrase(true);
    if (pass.length < MIN_PASSPHRASE) die(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
    if (values.cage && !values.org) die("--cage needs --org");
    const organization = values.org ? { name: values.org, ...(values.cage ? { cage: values.cage } : {}) } : undefined;
    if (!values.roles && !organization) die("--roles is required unless --org is given (a workflow-only key)");
    const { keyFile, trusted } = await createKey({ name: values.name, roles: values.roles ? keyRoles(values.roles) : [], passphrase: pass, validDays: days, organization });
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
  case "authority": {
    const [action, file] = positionals;
    if (action !== "sign" || !file || !values.key || !values.out) die("usage: tdp authority sign <authority.json> --key <root.key.json> --out <signed.json>");
    const bytes = new Uint8Array(readFileSync(file));
    const config = AuthorityConfig.parse(JSON.parse(utf8.decode(bytes)));
    const key = await unlockKey(readFileSync(values.key, "utf8"), await passphrase(false));
    if (!key.roles.includes("root")) die(`${key.name}'s key is not a root key`);
    writeJson(values.out, await signConfig("tdp-authority/0.1", bytes, key));
    console.log(`signed ${values.out}: authority ${config.id} serial ${config.serial}${config.fixture ? " (LABORATORY FIXTURE)" : ""}, by ${key.name}`);
    break;
  }
  case "record": {
    const [action, file] = positionals;
    if (action === "new") {
      if (!file || !values.out) die("usage: tdp record new <package.tdp> --out <ledger.json> [--item ID@REV] <context>");
      refuseExisting(values.out);
      values.package = file;
      const c = await workflowContext();
      const ledger = wf.createLedger(c, values.item);
      writeJson(values.out, ledger);
      console.log(`new ledger ${ledger.instance.id} for ${ledger.instance.item.itemId}@${ledger.instance.item.revision} in baseline ${ledger.instance.baselineId}: ${values.out}`);
      break;
    }
    if (!file) die("usage: tdp record add|verify|checkpoint <ledger.json> ... (run tdp with no arguments for details)");
    if (action === "add") {
      if (!values.key || !values.action || !values.role || !values.outcome || !values.reason || !values.data)
        die("usage: tdp record add <ledger.json> --package <tdp> --key <key.json> --action <transition> --role <workflow-role> --outcome <outcome> --reason <text> --data <data.json> <context>");
      const c = await workflowContext();
      const evidence = await wf.evidenceRefs(values.evidence ?? [], values.synthetic);
      const key = await unlockKey(readFileSync(values.key, "utf8"), await passphrase(false));
      try {
        const { ledger, record, sha256 } = await wf.addRecord(wf.readLedger(file), c, key, {
          action: values.action, role: values.role, outcome: values.outcome, reason: values.reason, dataJson: readFileSync(values.data, "utf8"),
          serial: values.serial, lot: values.lot, evidence,
        });
        writeJson(values.out ?? file, ledger);
        console.log(`record ${record.seq}: ${record.action} → ${record.outcome} by ${key.name} as ${record.actor.role} (${record.actor.organization}), sha256 ${sha256}${values.at ? "\n  record time from --at: that is the signer's claim, not a trusted timestamp" : ""}`);
      } catch (e) {
        if (e instanceof RecordDenied) {
          console.error(`DENIED  ${values.action} by ${key.name} as ${values.role}: ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
      break;
    }
    if (action === "verify" || action === "checkpoint") {
      const c = await workflowContext();
      const r = await verifyLedger(JSON.parse(readFileSync(file, "utf8")), c.ctx);
      if (action === "checkpoint") {
        if (!values.out) die("usage: tdp record checkpoint <ledger.json> --out <checkpoint.json> <context>");
        const cp = await wf.checkpointFor(r, c.ctx.now);
        writeJson(values.out, cp);
        console.log(`checkpoint ${values.out}: ${cp.count} records, head ${cp.head}. Keep it where the ledger's holder can't change it.`);
        break;
      }
      for (const l of wf.formatLedger(r, c)) console.log(l);
      if (values.checkpoint) {
        const problem = wf.checkAgainst(r, readFileSync(values.checkpoint, "utf8"));
        console.log(problem ? `FAIL  checkpoint  ${problem}` : `PASS  checkpoint  ledger contains the retained checkpoint's history`);
        if (problem) { console.log("REJECTED"); process.exit(1); }
      }
      console.log(r.verdict.toUpperCase());
      process.exit(r.verdict === "verified" ? 0 : r.verdict === "held" ? 3 : 1);
    }
    die(`unknown record action ${action}`);
    break;
  }
  case "evidence": {
    const [action, file] = positionals;
    if (action === "verify") {
      if (!file || !values.trust) die("usage: tdp evidence verify <bundle.signed.json> --trust <trust-store.json> [--anchors <anchors.json>]");
      const store = await trustStoreFromArgs();
      const r = await verifySignedEvidence(JSON.parse(readFileSync(file, "utf8")), store);
      if (r.problem) { console.log(`FAIL  ${r.problem}`); process.exit(1); }
      console.log(`PASS  evidence bundle signed by ${r.signer}, sha256 ${r.sha256} (the signature says who exported it, not that its contents are true)`);
      break;
    }
    if (action !== "export" || !file || !values.out) die("usage: tdp evidence export <ledger.json> --package <tdp> --out <bundle.json> [--key <key.json>] <context>");
    const c = await workflowContext();
    const bundle = await wf.exportEvidence(readFileSync(file, "utf8"), c, { proposals: values.proposals, acks: values.acks });
    if (values.key) {
      const key = await unlockKey(readFileSync(values.key, "utf8"), await passphrase(false));
      writeJson(values.out, await signEvidenceBundle(bundle, key, c.ctx.now));
      console.log(`signed by ${key.name}`);
    } else writeJson(values.out, bundle);
    console.log(`evidence bundle ${values.out}: ledger ${bundle.ledger.verdict}, ${bundle.records.length} records, ${bundle.records.reduce((n, r) => n + r.evidence.length, 0)} evidence references (no keys or secrets included)`);
    for (const [k, v] of Object.entries(bundle.status)) console.log(`  ${k}: ${v}`);
    break;
  }
  case "sync": {
    const [action, a1, a2] = positionals;
    if (action === "export") {
      if (!a1 || !values.recipe || !values.fixture || !values.out) die("usage: tdp sync export <ledger.json> --package <tdp> --recipe <recipe.json> --fixture <fixture.json> --out <proposals.json> <context>");
      const c = await workflowContext();
      const known = values["known-acks"] ? readFileSync(values["known-acks"], "utf8") : undefined;
      const knownP = values["known-proposals"] ? readFileSync(values["known-proposals"], "utf8") : undefined;
      const p = await wf.syncExport(readFileSync(a1, "utf8"), c, readFileSync(values.recipe, "utf8"), readFileSync(values.fixture, "utf8"), known, knownP);
      writeJson(values.out, p);
      for (const t of p.transactions) console.log(`  ${t.status.padEnd(11)} ${t.txId} ${t.operation} ${t.target.objectType}/${t.target.objectId}${t.expectedVersion ? ` expecting v${t.expectedVersion}` : ""}${t.lossy.length ? ` lossy: ${t.lossy.map((l) => l.field).join(", ")}` : ""}`);
      for (const x of p.excluded) console.log(`  excluded    ${x.kind} ${x.recordId}: ${x.reason}`);
      console.log(`wrote ${values.out}: ${p.transactions.length} transactions (proposals only; nothing was sent anywhere)`);
      break;
    }
    if (action === "apply-fixture") {
      if (!a1 || !values.fixture || !values.out) die("usage: tdp sync apply-fixture <proposals.json> --fixture <fixture.json> --out <acks.json>");
      const signer = values.key ? await unlockKey(readFileSync(values.key, "utf8"), await passphrase(false)) : undefined;
      const { acks, state } = await wf.syncApplyFixture(readFileSync(a1, "utf8"), readFileSync(values.fixture, "utf8"), new Date(), signer);
      if (signer) console.log(`acknowledgements signed by ${signer.name}`);
      writeJson(values.out, acks);
      writeJson(values.fixture, state);
      for (const a of acks.acks) console.log(`  ${a.status.padEnd(11)} ${a.txId} ${a.objectType}/${a.objectId}${a.sourceVersion ? ` v${a.sourceVersion}` : ""}: ${a.reason}`);
      console.log(`LOCAL FIXTURE adapter (${acks.adapter.label}) wrote ${values.out} and updated ${values.fixture}. This is not Onshape or Windchill.`);
      break;
    }
    if (action === "import") {
      if (!a1 || !a2) die("usage: tdp sync import <proposals.json> <acks.json>");
      let trust;
      if (values.trust || values.authority) {
        if (!values.trust || !values.authority) die("sync import: give both --trust and --authority to check the acknowledgement signature");
        const anchors = values.anchors ? await loadAnchors(readFileSync(values.anchors, "utf8")) : undefined;
        trust = { trustStore: await trustStoreFromArgs(), authority: (await loadAuthority(readFileSync(values.authority, "utf8"), { anchors })).config };
      } else console.log("NOTE  no --trust/--authority: acknowledgement signatures not checked");
      const r = await wf.syncImport(readFileSync(a1, "utf8"), readFileSync(a2, "utf8"), trust);
      if (r.signedBy) console.log(`acknowledgements signed by ${r.signedBy}`);
      for (const row of r.rows) console.log(`  ${row.state.padEnd(11)} ${row.tx.txId} ${row.tx.target.objectType}/${row.tx.target.objectId}${row.ack ? `: ${row.ack.reason}` : ""}`);
      for (const t of r.changeRequests) console.log(`  NOTE  ${t.target.objectType}/${t.target.objectId}: approval at the source needs a newly published baseline; no baseline was changed`);
      for (const p of r.problems) console.log(`FAIL  ${p}`);
      process.exit(r.problems.length ? 1 : 0);
    }
    if (action === "check-publication") {
      if (!values.fixture === !values.onshape) die("usage: tdp sync check-publication --package <tdp> (--fixture <fixture.json> | --onshape) <context>");
      const c = await workflowContext();
      const adapter = values.onshape ? new OnshapeReadAdapter(new OnshapeClient(credentialsFromEnv())) : readFileSync(values.fixture!, "utf8");
      if (values.onshape) console.log("reading Onshape (read-only; nothing is written to Onshape)");
      const checks = await wf.checkPublication(c, adapter);
      for (const ch of checks) console.log(`  ${ch.status.padEnd(12)} ${ch.message}`);
      process.exit(checks.every((ch) => ch.status === "current") ? 0 : 1);
    }
    die("usage: tdp sync export|apply-fixture|import|check-publication ...");
    break;
  }
  case "source": {
    const [action] = positionals;
    if (action !== "onshape-ref" || !values.id || !values.document || !values.version || !values.element || !values.revision)
      die("usage: tdp source onshape-ref --id <source-id> --document <did> --version <vid> --element <eid> --revision <rev> [--part-number <pn>] [--out <ref.json>]");
    const adapter = new OnshapeReadAdapter(new OnshapeClient(credentialsFromEnv()));
    const ref = await adapter.captureReference({ id: values.id, documentId: values.document, versionId: values.version, elementId: values.element, partNumber: values["part-number"], revision: values.revision });
    if (values.out) writeJson(values.out, ref);
    console.log(JSON.stringify(ref, null, 2));
    console.error("Captured from Onshape for the engineering model. The release state is declared, not verified: record source-release evidence under your authority configuration.");
    break;
  }
  default:
    die(`usage:\n${USAGE}`);
}
