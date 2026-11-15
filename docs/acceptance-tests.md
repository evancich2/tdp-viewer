# Acceptance tests: allowed, denied, reconciliation

Every laboratory demonstration (`npm run lab`, asserted by `npm test`) is classified as one of:

| Category | Meaning | How it's shown |
|---|---|---|
| **allowed** | A path the engine must accept | The step is signed through the gate and the ledger verifies |
| **denied** | A step the engine must refuse, or a result it must hold | Refused **before signing** (nothing is signed; CLI exit 1), or a validly signed but forbidden record **rejected on verification**, or held as **indeterminate**, never an automatic pass |
| **reconciliation** | The exchange boundary with a source system | Idempotent replay, conflicts, transaction-id reuse, lossy mappings, signed acknowledgements, publication version checks; the baseline is never altered |
| **measurement** | The software's own performance | Timings on this machine; no physical cycle time or yield is claimed |

The classification is an explicit table (`DEMO_CATEGORIES` in `tools/lab-scenario.ts`). A new
demonstration that isn't classified fails the test suite. Current counts and each result are in
[`samples/lab/demo-results.md`](../samples/lab/demo-results.md).

## Coverage by area

| Area | Allowed | Denied | Reconciliation |
|---|---|---|---|
| Identity and release (P01) | trusted 0.2 and 0.1 packages; release evidence recorded; rev B supersedes rev A, A preserved | possession ≠ authorization; new work on a superseded baseline | |
| Process and build (P02) | suitability with gap review; failed build requeued; delegation; one lot, several units | | |
| Inspection and disposition (P03) | accept, then a separate disposition | reject → NCR; indeterminate within U; unit mismatch or no calibration → held; accept of a held result; cross-unit disposition | |
| Invalid transitions (P04) | | skipped steps; missing approval or evidence; a false outcome claim; stale geometry | |
| Authorization (P05) | | no grant; revoked key; outside the CIP window; offline freshness exceeded; wrong organization; self-delegation; unpinned process; expired authority; CIP use limit | |
| Integrity and recovery (P06) | recovery from retained files; consistency and inclusion proofs | edited, removed or truncated records; altered evidence; tampered baseline; forked heads; an edited evidence bundle | |
| Exchange (P07) | | | create/update with expected version; replay is a no-op; id reuse rejected; conflict blocks dependent updates; NCR → change request needing a new baseline; superseded source; forged or unsigned acks refused |
| Replacement articles (P09) | discrepant first article stays held under its NCR; the replacement is traceable to it | replacement claims for a missing NCR, for itself, for another unit's NCR, or a second concurrent replacement; a resolution stated without accuracy evidence → indeterminate | |

## Also covered by unit tests

- `tests/json.test.ts`: strict loading (duplicate names, lone surrogates, depth) and RFC 8785 conformance.
- `tests/replacement.test.ts`: the replacement gate (rework, chains, one claim per unit), per-unit
  evidence bundles, instrument resolution versus calibration.
- `tests/keyfile.test.ts`: truncated GCM tags, unbounded scrypt parameters, mismatched key pairs.
- `tests/fuzz.test.ts` and the ledger mutation test: mangled inputs never throw and never verify.
