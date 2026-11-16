# Cross-package references — bounded local review

Status: local identity review is implemented as an explicit `tdp-manifest/0.3` profile carrying a
signed, listed `tdp-references/0.1` file. Existing 0.1/0.2 manifests and engineering 0.1 are unchanged.
Older strict verifiers reject 0.3. Shared partner adoption, interoperability and signed policy-aware
adjudication remain open. The contract below separates implemented identity review from future authority.

## Local use and limits

Set `engineering` and `references` file paths in `tdp-package.json` when packing. The reference file
has `schema: "tdp-references/0.1"` and a `references` array. Entries carry `id`, `relationship`,
`purpose`, descriptive `tags`, and `target`. A target has `kind` (`baseline` or `record`), `packageId`,
`manifestSha256`, `baselineId`, and for records, `recordId` and `recordSha256`. Unknown fields and
duplicate reference IDs are rejected; unknown descriptive tags are retained.

```
npm run references -- --source source.tdp --trust trust.json --target target.tdp
# Signed trust store: add --anchors roots.json. Fixed evaluation: add --at ISO-time.
```

The command verifies supplied local packages and reports `matched` or `held`, always with
`authorized: false`. Exit 0 means all identities matched, 2 means a hold, and 1 means an input error.
The core API also accepts already verified baseline-bound ledger results. The first CLI does not
load ledger contexts, so record targets remain held there. It never retrieves URLs or contacts a printer.
Limits: 128 packages/ledgers, 128 references per set, depth 8 by default (maximum 32), and 2,048
target visits. Cycles and exhausted bounds hold. Authoritative-content fingerprints are indexed once.

A `modified` reference needs `change` with a reason, exact predecessor and a request record target.
Both versions remain retained; a standing request still requires authorized recorded resolution.
Packages with nonempty references hold new planning, authorization, queueing and build-start steps.
The next-action display and signing gate enforce the same hold; historical verification retains it.
Identity matching cannot clear that policy-aware engineering review hold.

## Exact identities

Each reference needs a relationship kind, an explicit target type and a complete immutable target:

| Target | Required identity | Resolution check |
|---|---|---|
| Package baseline | package UUID + original manifest-byte SHA-256 + baseline ID | Verify package integrity, configured trust and exact baseline identity |
| Workflow record | record UUID + canonical record SHA-256 | Verify digest, signature, ledger context, applicable policy and baseline binding |

The existing `baseline.supersedes` link illustrates exact-version baseline binding. An item number,
revision label, URL, filename or "latest" alone cannot resolve a reference. Locators are retrieval
hints, not authority. Referenced evidence keeps its raw-byte digest. Canonical record digests use
the [shared hashing contract](canonical-json.md) and [test vectors](../samples/vectors/canonical-json.json).

## Resolution and conflict decisions

| Situation | Required result | Evidence to retain |
|---|---|---|
| Two packages claim the same item/revision with different authoritative content | Hold the dependent action as conflicting; never select by arrival time | Both exact baseline identities, differing artifact hashes, conflict reason and reviewer decision |
| Target baseline is superseded | Preserve the historical link; hold new restricted work pending explicit authority/review | Old and successor identities, governing CIP and permitted action; do not rewrite the reference |
| Target cannot be found, hash differs, trust fails, or required policy is unavailable | Unresolved/invalid hold with a specific reason | Requested exact identity and resolution failure; no guessed replacement |
| Target matches and is verified | Resolved identity only; separately evaluate authority and applicability | Verification result, policy version, actor and decision |

## Modified artifacts and standing changes

A legitimate modification is retained as a new content fingerprint under the stable object identity,
tagged `modified`, with an exact link to its predecessor and a standing change request explaining
the reason. For example, a shop-floor STEP revision for machinability stays in the evidence record;
the system does not eliminate it merely because it differs from the source design. Preserve both
original and modified bytes, hashes, provenance and the reason rather than rewriting either baseline.

The standing change request must identify both versions and the deviation. Its recorded resolution
can adjudicate the reference/conflict hold under the governing process; no silent content selection
is permitted. Merely retaining a deviation does not make it an approved released definition or grant
manufacturing authority. Applicable policy and authorized disposition remain explicit. A modified
file presented under an unchanged old digest is still an integrity failure, not a valid new version.

Synthetic tests cover modified references retained/tagged, missing reason/change request held,
exact predecessor/request checks and unchanged-digest tampering rejected. Authorized change
adjudication and retention through its future resolution workflow remain unimplemented.

Retrieval must use a configured local repository or explicitly permitted adapter. The browser's
no-network policy stays intact. Bound traversal depth and visited identities to avoid cycles and
resource exhaustion. A cached target is usable only under its explicit freshness/authorization rules.

## Vocabulary and gates

Evidence tags remain free text. A versioned process definition can require particular tags for a
gate; unrecognized descriptive tags are retained, not silently turned into requirements. Relationship
vocabulary and extension namespaces need shared agreement; taxonomy discovery cannot confer authority.
AI may propose a link but cannot resolve a conflict or approve a baseline.

## Remaining policy and interoperability work

The signed profile and local reviewer have tests for round trips, missing/mismatched/untrusted targets,
exact records, competing authoritative content, supersession, cycles/bounds, unknown tags, modified
versions, workflow holds and existing package compatibility. Next agree the shared authority/process
contract and permitted prototype samples before implementing signed resolutions, release policy or
enterprise retrieval. No shared canonicalization adoption, partner integration or physical validation
is inferred from these local software tests.
