# Cross-package references — proposed contract

Status: design for STDP-013 review, not an implemented schema or verified multi-package product.
Existing `tdp-manifest/0.2` verification is unchanged. A future optional `references` array needs
an agreed schema/version and compatibility tests before it is added to the engineering model.

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

Future acceptance tests must show: modified input retained/tagged; missing reason/change request
holds dependent work; exact-version change request retained through resolution; and unchanged-digest
tampering rejected. This is proposed workflow behavior, not a claim of implemented change adjudication.

Retrieval must use a configured local repository or explicitly permitted adapter. The browser's
no-network policy stays intact. Bound traversal depth and visited identities to avoid cycles and
resource exhaustion. A cached target is usable only under its explicit freshness/authorization rules.

## Vocabulary and gates

Evidence tags remain free text. A versioned process definition can require particular tags for a
gate; unrecognized descriptive tags are retained, not silently turned into requirements. Relationship
vocabulary and extension namespaces need shared agreement; taxonomy discovery cannot confer authority.
AI may propose a link but cannot resolve a conflict or approve a baseline.

## Smallest future implementation and acceptance

After review, add an optional references array containing the exact identities above, relationship,
purpose and descriptive evidence tags. Do not fetch targets automatically or infer transitive release.
First test round-trip preservation and explicit held outcomes; then add policy-aware resolution.
Acceptance includes missing/mismatched targets, competing revisions, superseded targets, cycles,
unknown tags, unauthorized actors, and byte-identical verification of existing 0.2 packages without
the new field. Agree how older strict-schema verifiers reject or negotiate the extension before release.
