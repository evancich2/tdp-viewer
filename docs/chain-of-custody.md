# Chain of custody (design)

Status: partly built. Signed, hash-chained workflow records bound to a baseline digest now exist as ledgers beside the package ([engineering-workflow.md](engineering-workflow.md)), with checkpoints that detect truncation against an independently retained copy. The Merkle log, exchanged tree heads and anchoring below are still planned (see [ROADMAP.md](../ROADMAP.md)). This note records the design and why it isn't a blockchain.

## The goal

For any package, anyone holding it should be able to answer, without trusting a central server:

- **Who** handled it, and **what** they did: packaged, signed, transferred, received, inspected, printed.
- **When**, as far as that can be established. A signature alone does not prove time: a signer can put any time in a record. Only an independent time source (an RFC 3161 timestamp, or a tree head already held by another party) bounds it.
- That **no event was edited or removed** afterwards. A hash chain proves this for the middle of the history only. Dropping the newest events leaves a chain that still verifies, unless someone independently retained a checkpoint or tree head that covered them.

### What exists today, and its limits

Workflow ledgers (`tdp-ledger/0.1`) are signed and hash-chained, and every record names the baseline manifest digest. They detect edits, reordering and removals in the middle. They detect truncation or a fork only when checked against a checkpoint (`tdp record checkpoint`) kept by someone other than the ledger's holder. Record times are the signer's claim. None of this is a Merkle log yet, and nothing is anchored.

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
