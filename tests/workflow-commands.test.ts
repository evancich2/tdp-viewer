// The CLI's workflow layer (tools/workflow-commands.ts) against the committed synthetic lab fixtures.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyLedger } from "../src/core";
import {
  checkAgainst, checkPublication, checkpointFor, createLedger, evidenceRefs, exportEvidence, formatLedger,
  loadContext, mediaTypeFor, readLedger, syncApplyFixture, syncExport, syncImport, type ContextArgs, type LoadedContext,
} from "../tools/workflow-commands";

const LAB = "samples/lab";
const args: ContextArgs = {
  package: `${LAB}/SYN-PH-2000_A.tdp`, trust: `${LAB}/trust-store.signed.json`, anchors: `${LAB}/anchors.json`,
  authority: `${LAB}/authority.signed.json`, process: `${LAB}/processes/printed-part-v1.json`,
  evidenceDir: `${LAB}/evidence`, at: "2026-11-12T13:00:00Z",
};
const text = (p: string) => readFileSync(p, "utf8");
let c: LoadedContext;
beforeAll(async () => { c = await loadContext(args); });

describe("loadContext", () => {
  it("loads and describes the trust store, authority, process, package and evidence", () => {
    expect(c.verify.verdict).toBe("trusted");
    expect(c.trustStoreSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.notes).toHaveLength(5);
    expect(c.notes.join("\n")).toMatch(/signed by .*serial/);
    expect(c.notes.join("\n")).toMatch(/evidence: \d+ files hashed/);
    expect(c.ctx.now.toISOString()).toBe("2026-11-12T13:00:00.000Z");
  });

  it("refuses an unparseable --at, an untrusted package and an untrusted successor", async () => {
    await expect(loadContext({ ...args, at: "yesterday" })).rejects.toThrow(/not a time/);
    // The lab trust store doesn't hold the keys that signed the general sample package.
    await expect(loadContext({ ...args, package: "samples/sample.tdp" })).rejects.toThrow(/package samples\/sample.tdp is not trusted/);
    await expect(loadContext({ ...args, successors: ["samples/sample.tdp"] })).rejects.toThrow(/--successor samples\/sample.tdp is not trusted/);
  });

  it("reports whether a loaded package supersedes the baseline", async () => {
    const withB = await loadContext({ ...args, successors: [`${LAB}/SYN-PH-2000_B.tdp`] });
    expect(withB.notes.at(-1)).toMatch(/^superseded by: /);
    expect(withB.ctx.successors).toHaveLength(1);
    const withSelf = await loadContext({ ...args, successors: [`${LAB}/SYN-PH-2000_A.tdp`] });
    expect(withSelf.notes.at(-1)).toBe("no loaded package supersedes this baseline");
  });
});

describe("ledger helpers", () => {
  it("creates a ledger for a baseline item, or refuses one that isn't in it", () => {
    const item = c.ctx.baseline.model.items[0]!;
    expect(createLedger(c, `${item.itemId}@${item.revision}`).instance).toMatchObject({ item: { itemId: item.itemId, revision: item.revision } });
    expect(() => createLedger(c, `${item.itemId}@ZZ`)).toThrow(/not in the baseline/);
    expect(() => createLedger(c, item.itemId)).toThrow(/not in the baseline/);
  });

  it("hashes --evidence ID=TAG=PATH, keeping = in paths, and rejects incomplete specs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wf-ev-"));
    const path = join(dir, "a=b.csv");
    writeFileSync(path, "x,y\n");
    const [ref] = await evidenceRefs([`EV-1=measurements=${path}`], true);
    expect(ref).toEqual({ id: "EV-1", tag: "measurements", sha256: createHash("sha256").update("x,y\n").digest("hex"), mediaType: "text/csv", description: "a=b.csv", synthetic: true });
    for (const bad of ["EV-1", "EV-1=tag", "=tag=path", "EV-1==path"]) await expect(evidenceRefs([bad], false)).rejects.toThrow(/ID=TAG=PATH/);
  });

  it("maps file extensions to media types, case-insensitively, with a safe default", () => {
    expect(mediaTypeFor("x/part.STEP")).toBe("model/step");
    expect(mediaTypeFor("job.3mf")).toBe("model/3mf");
    expect(mediaTypeFor("README")).toBe("application/octet-stream");
    expect(mediaTypeFor("archive.tar.gz")).toBe("application/octet-stream");
  });
});

describe("status, checkpoints and evidence export", () => {
  it("formats a single-unit ledger with its state and next actions", async () => {
    const r = await verifyLedger(readLedger(`${LAB}/ledgers/SN-0001.ledger.json`), c.ctx);
    const out = formatLedger(r, c).join("\n");
    expect(out).toMatch(/package integrity +verified/);
    expect(out).toMatch(/state: /);
    expect(out).not.toMatch(/^unit /m);
  });

  it("formats a lot ledger per unit, with the instance state marked", async () => {
    const r = await verifyLedger(readLedger(`${LAB}/ledgers/LOT-0004.ledger.json`), c.ctx);
    expect(r.units.length).toBeGreaterThan(1);
    const out = formatLedger(r, c).join("\n");
    expect(out).toMatch(/\(instance level\)/);
    expect(out.match(/^unit /gm)).toHaveLength(r.units.length);
  });

  it("shows status but no state or next actions for a rejected ledger", async () => {
    const r = await verifyLedger(readLedger(`${LAB}/ledgers/invalid-skip.ledger.json`), c.ctx);
    expect(r.verdict).toBe("rejected");
    const out = formatLedger(r, c).join("\n");
    expect(out).toMatch(/inspection /);
    expect(out).not.toMatch(/state: |next: /);
  });

  it("accepts the committed checkpoint for its ledger and catches a truncated one", async () => {
    const cp = text(`${LAB}/ledgers/SN-0001.checkpoint.json`);
    expect(checkAgainst(await verifyLedger(readLedger(`${LAB}/ledgers/SN-0001.ledger.json`), c.ctx), cp)).toBeNull();
    expect(checkAgainst(await verifyLedger(readLedger(`${LAB}/ledgers/SN-0001-truncated.ledger.json`), c.ctx), cp)).toMatch(/./);
    const fresh = await checkpointFor(await verifyLedger(readLedger(`${LAB}/ledgers/SN-0001.ledger.json`), c.ctx), c.ctx.now);
    expect(checkAgainst(await verifyLedger(readLedger(`${LAB}/ledgers/SN-0001.ledger.json`), c.ctx), JSON.stringify(fresh))).toBeNull();
  });

  it("builds an evidence bundle, with and without reconciliation rows", async () => {
    const ledger = text(`${LAB}/ledgers/SN-0001.ledger.json`);
    const plain = await exportEvidence(ledger, c);
    const reconciled = await exportEvidence(ledger, c, { proposals: `${LAB}/exchange/SN-0001.proposals.json`, acks: `${LAB}/exchange/SN-0001.acks.json` });
    const proposalsOnly = await exportEvidence(ledger, c, { proposals: `${LAB}/exchange/SN-0001.proposals.json` });
    expect(plain.reconciliation).toBeNull();
    const txs = reconciled.reconciliation!.transactions;
    expect(txs.length).toBeGreaterThan(0);
    expect(txs.some((t) => t.ack !== null)).toBe(true);
    // Proposals without acknowledgements: every transaction listed, none acknowledged.
    expect(proposalsOnly.reconciliation!.transactions.map((t) => t.txId)).toEqual(txs.map((t) => t.txId));
    expect(proposalsOnly.reconciliation!.transactions.every((t) => t.ack === null)).toBe(true);
  });
});

describe("sync with the local fixture source", () => {
  it("exports proposals, applies them to the fixture, and imports the acknowledgements", async () => {
    const proposals = await syncExport(text(`${LAB}/ledgers/SN-0001.ledger.json`), c, text(`${LAB}/exchange/recipe.json`), text(`${LAB}/exchange/fixture-source.initial.json`));
    const pj = JSON.stringify(proposals);
    const applied = await syncApplyFixture(pj, text(`${LAB}/exchange/fixture-source.initial.json`), c.ctx.now);
    const imported = await syncImport(pj, JSON.stringify(applied.acks));
    expect(imported.rows.length).toBeGreaterThan(0);
    // Already-acknowledged versions are passed through as known on the next export.
    const again = await syncExport(text(`${LAB}/ledgers/SN-0001.ledger.json`), c, text(`${LAB}/exchange/recipe.json`), JSON.stringify(applied.state), JSON.stringify(applied.acks), pj);
    expect(again).toBeDefined();
  });

  it("checks publication against a fixture given as JSON text", async () => {
    expect(await checkPublication(c, text(`${LAB}/exchange/fixture-source.initial.json`))).toBeDefined();
  });

  it("refuses malformed exchange files through the strict parser", async () => {
    await expect(syncImport('{"a":1,"a":2}', "{}")).rejects.toThrow(/duplicate member name/);
    await expect(syncApplyFixture("{}", "not json")).rejects.toThrow(/not valid JSON/);
  });
});
