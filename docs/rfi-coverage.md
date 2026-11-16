# RFI Revision 1 — evidence coverage

Working mapping for STDP-007, November 15, 2026. Gap identifiers refer to the shared RFI Revision 1.
Software coverage below is a laboratory result using synthetic data or mocks. It is not closure of
an access, physical, commercial or approval dependency. No issue acceptance or disposition is asserted.

The G-01–G-20 identifiers and descriptions were cross-checked against the supplied RFI Revision 1
gap table. The list is available; the remaining dependency is the actual closure evidence and
agreed ownership, not another copy of the list. Private source documents stay outside this repo.

| Gap | Existing demonstration / test | Remaining evidence or development |
|---|---|---|
| G-01 CAD access | `tests/onshape.test.ts`: signed GETs, unsafe identifiers, auth/rate-limit handling | Live licensed account, API rights and permitted document; mock tests do not prove access |
| G-02 PLM access | No Windchill integration evidence | Sandbox/version/license/API permissions; implement only against agreed contract |
| G-03 Dataset rights | Package integrity tests in `tests/verify.test.ts` | Controlled source baseline and written usage permissions; cryptography cannot establish rights |
| G-04 CAD fidelity | `tests/workflow.test.ts`: revision-unstable STEP solid links rejected; browser STEP preview | Native/AP242 semantics and PMI/occurrence fidelity across export/change remain unverified |
| G-05 Transactions | P07; `tests/workflow.test.ts`: deterministic IDs, mismatched acknowledgements and wrong baseline rejected | Real enterprise create/update permissions and adapter reconciliation; Onshape adapter is read-only |
| G-06 AI provider | No engineering-model provider evaluation | Provider/version, terms and approved deployment; SSH-agent tests are not AI tests |
| G-07 AI review boundary | Deterministic workflow gates; P04/P05 forbidden actions denied | Structured model proposal contract and tests against malformed/unauthorized model outputs |
| G-08 AI metrics | Uncovered | Human-reviewed corpus, precision/recall, unsupported-assertion/correction targets and baseline trial |
| G-09 AI data boundary | Viewer CSP exercised by `tests/e2e/*` | Model privacy/retention agreement and cross-context retrieval tests; CSP is not provider assurance |
| G-10 Assembly | Existing item/occurrence schema; single-part P01–P09 | [Bounded assembly plan](phase2-assembly-scope.md); design/BOM and parent-hold implementation/testing open |
| G-11 Equipment | Simulated bridge tests plus two owner-executed builds in the private evidence intake | Earlier builds do not validate current main; retain exact firmware/settings/material/fixture provenance and perform authorized current-version hardware checks |
| G-12 Limits | Guard bands, TUR and missing-evidence holds; owner-approved BasePlate limit provenance is received privately | Controlled release authority, decision rule and qualified acceptance remain open; do not fabricate executable approved characteristics |
| G-13 Metrology | P09-b; `tests/replacement.test.ts`: resolution vs calibration | Actual reference ID/certificate, gauge readings, uncertainty and qualified engineering review |
| G-14 CIP | P05; signed policy, organization/role/unit checks in workflow tests | Agree shared syntax/version and governance; fixtures do not approve production policy |
| G-15 Offline policy | P05 stale/expired/revoked authorization; trust-store tests | Approved freshness window and operational revocation distribution/reconnect evidence |
| G-16 Delegation | Workflow tests: revoked keys, no re-delegation, signing vs workflow roles; P07 | Enterprise release authority and written transaction delegation; no autonomous source release |
| G-17 Two contexts | Workflow tests require different build/inspection organizations | Actual governed participants, identity/trust boundaries and relevant-environment definition |
| G-18 Quantitative validation | Lab performance measurements only | Approved sample sizes, engineering/AI/scale thresholds; no retrospective pass criteria |
| G-19 Evidence/defects | P06 tamper/recovery, P09 replacement; privately hash-verified actual records and original photos | Instrument qualification, witness/signature authority, warning resolution and defect dispositions; original article NCR remains separate |
| G-20 Program basis | Outside software test scope | Reconcile staffing/costs/milestones and execute required rights/employment agreements |

## How uncovered areas become tests

Do not replace absent hardware, rights, credentials, provider results or human approvals with invented
fixtures presented as real. On receipt of actual interfaces and an approved test protocol, add
contract tests for G-02/04/05, adversarial proposal/retrieval evaluations for G-07/08/09, and serialized
assembly/parent-hold tests for G-10. Record the dataset/version, expected result, actual result and
evidence hash. Register new lab demonstrations in `DEMO_CATEGORIES` so unclassified results fail.

The shared [canonical JSON vectors](../samples/vectors/canonical-json.json) support cross-prototype
digest checks. They do not prove interoperability with INV-01/02/03/05 until each supplies actual
sample output and an independent matching result. Existing open gaps remain open after this mapping.
