# Engineering workflow (laboratory demonstrator)

The workflow carries a released baseline through to a dispositioned physical part:

**import and verify a released baseline → inspect requirements and configuration → authorize a bounded manufacturing operation → record manual build evidence → capture inspection and disposition → export proposed downstream transactions for source-system reconciliation.**

Everything runs offline, in the browser or the `tdp` CLI, on the same core (`src/core/`). The reproducible demonstration, with exact commands and the evidence/gap matrix, is in [laboratory-demo.md](laboratory-demo.md).

## Four kinds of authority, kept apart

| Kind | Where it comes from | What it is *not* |
|---|---|---|
| Package-signing roles: `author`, `checker`, `approver`, `release` | Trust store `roles` (unchanged from v0.1) | Not a workflow role, not manufacturing permission, not source-system release |
| Engineering workflow roles: `requirement-owner`, `planner`, `operator`, `inspector`, `disposition-authority`, … | `grants` in the operator-trusted **authority configuration** (`tdp-authority/0.1`), or a delegation issued under such a grant | Never granted by a package or by the record that uses it |
| Organization membership | Trust store `organization` on each key (vouched for by the trust-store issuer), recognized by the authority configuration | A record's asserted organization must match the trust store |
| Source-system release authority | Authority configuration `sources`: which system (Onshape, Windchill, `lab-fixture`) is authoritative for which items and which states mean "released" | Not proven by a package signature; established only by a `source-release` record under that configuration |

A valid package signature establishes integrity and signer authorization under the trust policy. **Possessing or importing a package authorizes nothing.** The viewer shows five separate statuses (package integrity, source release, operation authorized, inspection, disposition), and none implies another.

The source PLM governs engineering release. Onshape is the intended initial source path, and Windchill the preferred enterprise target. Neither is integrated in this increment, so the demonstrator uses a clearly labeled **local laboratory authority fixture** (`"fixture": true`, label shown in every status that depends on it).

## The baseline: `tdp-manifest/0.2` and the engineering model

`tdp-manifest/0.1` packages verify exactly as before; no engineering model is inferred for them, and workflow records can't bind to them. A `tdp-manifest/0.2` manifest is identical except for one required field, `engineering: { path, schema: "tdp-engineering/0.1" }`, pointing at an ordinary listed, signed JSON file. An unknown manifest `schema` is rejected.

The engineering model (`src/core/engineering.ts`) is the minimum useful subset:

- **Identity:** baseline id, package id, root item; items (`itemId` + revision, mapped to BOM part numbers); **occurrences** (a use of a child item in a parent, distinct from the item's identity: the surrogate latch occurs twice in its assembly).
- **Revision, release and effectivity, kept separate:** item revision; source references with *declared* revision and release state (declarations, not proof); baseline effectivity (serial range or lots); `supersedes` for a new baseline.
- **Requirements and measurable characteristics:** absolute limits, unit, nominal, decision rule; requirement verification method.
- **Artifacts:** each tied to a manifest file by path *and* digest, with a class and whether it is authoritative.
- **Geometry links:** the method (`step-solid-index`, `step-entity-name`, `pmi-semantic-id`, `source-persistent-id`), selector, the digest of the artifact the selector was taken from, and stability. A STEP solid index or entity name identifies a position in one file, not an engineering feature, so it may only claim `this-artifact-only`; a model claiming otherwise is rejected. A link whose artifact digest differs from the baseline's artifact is **stale**, and planning is held until the plan records a review of it.
- **Typed relationships** (`verifies`, `describes`, `supersedes`, …) and provenance.

Inconsistencies with the manifest (unknown references, digest mismatches, wrong package id, an item revision different from the BOM) reject the package. Extension points are listed at the top of `engineering.ts`; each needs a schema version bump, never a silent reinterpretation.

## Signed enrichment records and the ledger

Released content stays immutable: downstream records are stored in a **ledger file** (`tdp-ledger/0.1`) beside the package, never inside it. Each record (`tdp-record/0.1`) contains:

- record id, sequence and schema version; workflow instance id;
- package id, **baseline manifest digest** and baseline id; item revision; physical serial or lot;
- actor key, asserted organization and workflow role;
- action (a transition of the process definition), time, previous-record digest;
- evidence references (id, tag, SHA-256, media type, synthetic flag);
- governing policy: process id, version and digest; authority id and serial;
- outcome, reason, and a typed payload (`requirements-approval`, `source-release`, `suitability`, `suitability-review`, `plan`, `authorization`, `queue-entry`, `build-start`, `build-complete`, `inspection`, `nonconformance`, `disposition`, `closure`, `delegation`).

The record is hashed as canonical JSON, and the signature is Ed25519 over `tdp-record-signature/0.1\n<sha256>`. Verification (`verifyLedger`) checks, for every record in order: the chain, the signature, trusted identity and organization binding, baseline and item binding, policy binding, role resolution, the transition gate, required evidence (hash-checked against supplied files), and payload semantics. It stops at the first failure. Missing evidence files give **held**, not verified.

**One unit or many.** A ledger may carry one physical unit or several (a lot, a batch of serials). Records with no unit (approvals, source release, suitability, planning, authorization) are shared. Records with a unit move that unit along its own track: state, prerequisites, independence rules, inspections and dispositions are judged per unit, so one unit's accepted inspection can never disposition another. Job ids, NCR ids and CIP ids are unique across the whole ledger.

**Hardware-backed keys.** Every CLI command that signs takes `--agent <keyId|comment>` instead of `--key`: the signature is made by an SSH agent, so the private key can live on a token: a YubiKey or other OpenPGP card with an Ed25519 key through gpg-agent's SSH support, or PIV Ed25519 (YubiKey firmware 5.7+) through ssh-agent with a PKCS#11 module. Only plain `ssh-ed25519` keys qualify (their agent signatures are ordinary Ed25519 signatures over our bytes); FIDO `sk-` keys sign something else and are refused. Each agent signature is checked against the public key before use. `tdp agent list` shows usable keys and `tdp agent entry` writes their trust-store or anchors entry. Tested with a software key in a private agent; no hardware token was available to test with.

**Recording in the browser.** The viewer can sign records too. Load a key file and its passphrase; the key is decrypted in memory with a dependency-free scrypt (`src/core/scrypt.ts`, tested against Node's) and imported non-extractable. It is never stored or sent. The form only collects inputs: `appendRecord` runs the same gate as the CLI, and a forbidden step is refused with nothing signed. The updated ledger is downloaded as a file.

The viewer's hash-chained audit log (`audit.ts`) is different: it is a local, unsigned record of what one browser session did. The signed ledger is the portable engineering record.

### What signatures and chains do not prove

- **Time.** A signature proves who signed which bytes, not when. Record times are the signer's claim. An RFC 3161 timestamp over a tree head (`tdp tree timestamp`) proves the records under it existed no later than the TSA's time; nothing gives a lower bound.
- **Truncation.** The chain detects edits, reordering and removals in the middle. It cannot detect that the newest records were dropped. That takes something held by another party: a signed tree head in a witness file (`tdp tree head`, `tdp tree witness`, `tdp tree check`; see [chain-of-custody.md](chain-of-custody.md)) or, more simply, a checkpoint (`tdp record checkpoint`, `--checkpoint`).
- **Revocation freshness.** Offline, nothing newer than the loaded trust store and authority configuration can be known. See the offline validity window below.

## Authorization

A record never grants its own signer authority. A role comes from a grant in the authority configuration, valid at the record time, or from a `delegation` record issued earlier by a key whose *configured* grant has `mayDelegate` for that role. Delegations can't be re-delegated, can't name their issuer, and stay within the issuer's organization.

Manufacturing operations need a **bounded authorization**: a Change Implementation Plan (`authorization` record) naming the operations, organizations, roles, serials or lots (inside baseline effectivity), validity period and policy version. It is bound to the baseline digest like every record. The issuer can't perform the operations it authorizes.

A CIP may also cap how often it can be used: `limits: [{ "transition": "dispatch-build", "max": 2 }]` allows at most two records of that transition to rely on it, across all units. A third attempt needs a new authorization.

**Superseded baselines.** When the operator loads a newer trusted baseline whose `supersedes` names this one (`--successor` in the CLI, **Load newer baselines…** in the viewer), new work under the old baseline stops: planning, authorization, queueing and starting builds are denied. Units already built may still be inspected, dispositioned and closed. Only baselines you have loaded are known; offline, the tool can't discover a newer one by itself.

The gate fails closed: missing grant, revoked key (trust store or authority), wrong organization, expired authority, process not pinned by digest, CIP for an older policy version (stale), CIP outside its window or not covering the unit, missing approval step, missing evidence, or incompatible configuration all deny.

**Offline validity window.** The authority configuration has `offlineValidityHours` (168 in the lab fixture). Transitions marked `freshAuthority` (manufacturing authorization, dispatch, disposition in the reference process) are denied once the configuration is older than that, because current revocation status can't be established offline. Load a freshly issued configuration to proceed. When a ledger is verified later, such records must have been made within the window of the configuration they name.

## Process definitions

The workflow is configuration (`tdp-process/0.1`), not code. It defines the states, the transitions (record kind, from-states, outcome → next state, roles, organization allowlist), the required prior actions, evidence tags, authorization operation, freshness and unit requirements, and the independence rules (`distinctActorFrom`, `distinctOrganizationFrom`). The authority configuration pins each allowed definition by SHA-256 of its bytes.

- `samples/lab/processes/printed-part-v1.json`, the reference process: requirements approval → source release evidence → process suitability (→ engineering gap review if needed) → build and inspection plan → manufacturing authorization (CIP) → manual queue → manual dispatch → build completion (a failure returns to `authorized`) → independent inspection (accept / reject / indeterminate) → NCR → disposition → evidence closure.
- `samples/lab/processes/printed-part-fai-v1.json`, the second configuration on the same engine: no queue, no gap acceptance, two independent inspections, disposition by a quality engineer.

## Process suitability and build records

`evaluateSuitability` checks the declared resource against the item. Build-volume fit is one check among several; it never establishes capability alone. Material must match the design. Firmware must be recorded, or it's a gap. Calibration evidence must be attached and current. Each characteristic needs attached, unexpired capability evidence, with a demonstrated deviation within its half-tolerance. A failure gives `not-suitable`, and any gap gives `review-required`, which the reference process sends to a design engineer who must address every gap explicitly. The engine recomputes the conclusion, so a record can't claim a better outcome than its inputs give.

Build records in this increment are manual: job id, submitted-file hash (attached as evidence), settings, operator, start and completion times, outcome and errors. The existing 3MF export is unchanged and still stamps provenance. Exporting a build file is not authorization.

## Inspection and disposition

Decision rules `core/decision-rules/0.1` (`src/core/inspection.ts`):

- **guard-banded:** accept if `lower + U ≤ x ≤ upper − U`, reject if `x < lower − U` or `x > upper + U`, otherwise indeterminate;
- **simple-acceptance:** indeterminate if the test uncertainty ratio `(upper − lower) / 2U` is below `minTur` (default 4), otherwise accept if `lower ≤ x ≤ upper`, else reject.

Values convert within a unit family (mm, µm, in; g, kg; deg) and round to 1e-9 before comparison. A missing measurement, incompatible unit, missing instrument, missing or expired calibration, or missing uncertainty makes the result **indeterminate (held)**: never an automatic pass. A record's stated outcome must equal the rules' result.

The measurement outcome is not a disposition. Only a `disposition-authority` (a different key from the inspector) dispositions. `accept` requires an accepted inspection, and any other decision requires an NCR raised against that inspection.

## Publishing and reconciliation

A TDP is data, not an executable or a container image. The exchange contract (`src/core/exchange.ts`):

- **Publishing recipe** (`tdp-recipe/0.1`): the selected baseline (id + manifest digest), the artifact classes and relationships it must contain, the permitted record kinds, the target system, and field mappings. Lossy mappings list what they drop and need explicit `acceptLoss`; mappings whose approval would change the definition are marked `changesDefinition`.
- **Adapter interface** (`SourceAdapter`): `describe`, `checkPublication` (compares the baseline's source declarations with the source's current revision and state), and `reconcile`.
- **Local fixture adapter** (`LocalFixtureAdapter`): a file-backed stand-in source system. It handles create, update proposal (expected source version), no change, conflict, unsupported type, held lossy mapping, and accepted or rejected acknowledgement. Transaction ids are deterministic. Replaying a transaction returns `duplicate` and changes nothing, and reusing an id with different content is rejected. After a failed transaction, later ones for the same object in the same set are refused.
- **Signed acknowledgements:** the authority configuration names which trust-store keys may acknowledge for each source system (`acknowledgementKeys`). With trust and authority loaded, `importAcknowledgements` refuses unsigned, edited or wrongly signed acknowledgements, and marks nothing as synchronized.
- **Acknowledgement import** reports only. It never rewrites the package or the ledger. A source-approved change is flagged as needing a newly published baseline.

### Onshape (read-only, CLI only)

`tools/onshape.ts` implements the adapter interface against Onshape's REST API using documented GET endpoints only (document, versions, revisions), with request-signature (HMAC-SHA256) API-key authentication. Credentials come from `ONSHAPE_ACCESS_KEY` / `ONSHAPE_SECRET_KEY` in the environment and are never written anywhere.

- `tdp source onshape-ref …` captures a source reference (document, version, element, part number, names) for an engineering model with `capture: "api-read"`. The release state stays a declaration.
- `tdp sync check-publication --onshape …` compares a baseline's Onshape references with Onshape's current versions and revisions: `current`, `superseded`, `mismatch`, `not-released` or `unknown`.
- `reconcile` answers every proposal `unsupported`: nothing is written to Onshape.

The public documentation doesn't fully specify the revision response, so fields are read defensively. When a field the decision needs is missing, the answer is `unknown`, never `current`. **It has been tested only against a fake transport, not a live Onshape account.** Verify it with real credentials before relying on it. The browser app never talks to Onshape or anything else. There is no Windchill adapter.

## Deferred, with interfaces kept open

Not in this increment: hosted or multi-tenant services, browser networking, live AI calls, automatic printer control, scanner integration, autonomous CAD generation, and production enterprise adapters. The seams for later are the `SourceAdapter` interface (Onshape and Windchill adapters, a hosted reconciliation service) and the record and process schemas, which are versioned and transport-independent. The intended split for AI assistance is that it may propose links, discrepancies and next actions as unsigned suggestions. Deterministic services and authorized humans keep acceptance and release authority. Credentials, printer access codes and other secrets stay outside packages, ledgers, fixtures and evidence bundles.
