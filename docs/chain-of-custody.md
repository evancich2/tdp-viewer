# Chain of custody (design)

Status: built, except public anchoring. Workflow ledgers are signed and hash-chained ([engineering-workflow.md](engineering-workflow.md)); a Merkle log over each ledger with signed tree heads, inclusion and consistency proofs, witness files and fork detection is in `src/core/custody.ts`; RFC 3161 timestamps over tree heads are in `tools/timestamp.ts` (CLI). Anchoring to a public transparency log or a blockchain is not built. This note records the design and why it isn't a blockchain.

## The goal

For any package, anyone holding it should be able to answer, without trusting a central server:

- **Who** handled it, and **what** they did: packaged, signed, transferred, received, inspected, printed.
- **When**, as far as that can be established. A signature alone does not prove time: a signer can put any time in a record. Only an independent time source (an RFC 3161 timestamp, or a tree head already held by another party) bounds it.
- That **no event was edited or removed** afterwards. A hash chain proves this for the middle of the history only. Dropping the newest events leaves a chain that still verifies, unless someone independently retained a checkpoint or tree head that covered them.

### What exists today, and its limits

- **Ledger chain:** detects edits, reordering and removals in the middle.
- **Signed tree heads** (`tdp-tree-head/0.1`): a party that does not hold the ledger (the receiving organization, an inspection lab) signs or receives a head over the records so far and keeps it in a witness file (`tdp tree witness`). `tdp tree check` then proves the ledger still contains every witnessed history: dropped newest records show as *truncated*, a rewritten history as *rewritten*. Two signed heads of the same size with different roots are proof of a fork by themselves, and a witness refuses the second.
- **Consistency proofs** (`tdp tree prove`) let a witness accept a newer head only if it extends the one it holds, without receiving the ledger; **inclusion proofs** show one record is under a head.
- **RFC 3161 timestamps** (`tdp tree timestamp`, `verify-timestamp`) over a head prove it existed no later than the TSA's time, so records under it can't later be backdated past that point. Only the head's SHA-256 is sent to the TSA. The TSA certificate is pinned by the verifier.

Limits: detection depends on someone actually keeping heads and comparing them; a party that has never seen a head can't detect anything. Timestamps bound time from above only. Heads say nothing about whether a record's content is true.

Today, signatures pin who approved which exact bytes, and the audit log is hash-chained. The gap is that each audit log lives on one machine, and whoever holds it could throw it away and start a new one.

## Design

### 1. Custody events

A signed record per handoff, with the same Ed25519 keys and trust store as package signatures:

```json
{
  "schema": "tdp-custody/0.1",
  "event": "received",
  "packageId": "…",
  "manifestSha256": "…",
  "actor": "<keyId>",
  "at": "2026-11-12T15:04:05Z",
  "prev": "<sha256 of the previous event>",
  "detail": { "from": "<keyId>", "note": "receiving inspection passed" }
}
```

Events travel with the package (`custody/` in the `.tdp`, outside the signed manifest so they can be appended without re-signing the contents). The viewer verifies each event's signature, its link to the previous event, and that it names this package's manifest digest.

### 2. Merkle-tree log with receipts

A custody log in the style of Certificate Transparency and Sigstore's Rekor: an append-only Merkle tree whose signed tree head commits to every event so far.

- **Inclusion proofs** show that an event is in the log.
- **Consistency proofs** show that a later log extends an earlier one, so nothing was removed or rewritten.
- It works offline. Organizations exchange signed tree heads, and any mismatch is proof of tampering.

### 3. Optional anchoring

Periodically publish only the signed tree head, a single hash, somewhere outside the operator's control:

- an RFC 3161 timestamp authority,
- a public transparency log,
- a blockchain, if a customer requires one.

No package data and no event details leave the system, only the root hash. Anchoring is a plug-in, not a dependency, so the design stays anchor-agnostic.

## Why not a blockchain at the core

| | Blockchain at the core | This design |
|---|---|---|
| Works offline or air-gapped | No: needs consensus to confirm | Yes |
| Metadata exposure | Public chains reveal timing and volume of handoffs | Only periodic root hashes, if anchoring is used |
| Tamper evidence | Yes | Yes (Merkle consistency proofs) |
| Multi-party, no single operator | Yes | Yes, via exchanged signed tree heads and optional public anchors |
| Operating cost | Nodes, fees or a consortium | A file and a few hundred lines of code |

A blockchain's unique property, consensus among parties who don't trust each other, is available here as an anchoring option for the deployments that need it.
