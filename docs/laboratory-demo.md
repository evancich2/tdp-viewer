# Laboratory demonstration (TRL 4 software increment)

> **Everything here is synthetic.** The part is a *surrogate* printed latch (`SYN-PH-2001`) for a build-plate handling assembly (`SYN-PH-2000`) for a Bambu printer, standing in until the controlled design is supplied. Its dimensions, limits, approvals, capability claims, calibration certificates, printer runs and measurements are invented and labeled as such in every file. The demo keys are derived from seeds published in `tools/lab-fixtures.ts`, so they protect nothing.

Design reference: [engineering-workflow.md](engineering-workflow.md).

## Reproduce it

```sh
npm install
npm run lab        # regenerates samples/lab/ and runs P01–P08; exits non-zero if any demonstration fails
npm test           # includes tests/workflow.test.ts, which asserts every demonstration
npm run e2e        # real Chrome, production CSP: drives the lab workflow in the viewer (needs Google Chrome)
```

`npm run lab` is deterministic: packages, ledgers, configs, evidence and exchange files come out byte-identical on every run. Only the measured timings (P08) in `demo-results.*` and `evidence-bundle-SN-0001.json` change. Results: [`samples/lab/demo-results.md`](../samples/lab/demo-results.md).

### In the viewer

`npm run dev`, then:

1. **Use lab demo keys** (pins the lab root and loads its signed trust store).
2. Open `samples/lab/SYN-PH-2000_A.tdp`. Package integrity is verified. Source release and authorization are *not* established.
3. **Use lab authority and processes**.
4. **Open ledger…** `samples/lab/ledgers/SN-0001.ledger.json`. The ledger is *held* until you **Add evidence files…** (everything in `samples/lab/evidence/`), then *verified*.
5. Try `invalid-skip.ledger.json` (rejected with the reason), `SN-0002` (reject → NCR → scrap), `SN-0003` (indeterminate, held) and, with the FAI process, `FAI-SN-0010`.
6. **Open proposals…** `samples/lab/exchange/SN-0002.proposals.json`, then **Import acknowledgements…** `SN-0002.acks.json`.
7. Open `SYN-PH-2000_B.tdp` to see the stale geometry link hold planning.
8. **Record a step:** with `SN-0003` open and the evidence loaded, open `samples/lab/keys/inspector.key.json` (written by `npm run lab`), enter the passphrase `lab-demo-passphrase (public, demo only)`, choose `raise-nonconformance`, and sign. A wrong characteristic is refused with nothing signed. Download the updated ledger.
9. Open `LOT-0004.ledger.json` and switch **Unit** between SN-0004 and SN-0005. Then **Load newer baselines…** with `SYN-PH-2000_B.tdp` to mark rev A superseded.

### Onshape (needs your API keys; read-only)

```sh
export ONSHAPE_ACCESS_KEY=… ONSHAPE_SECRET_KEY=…        # never written to any file
npm run -s tdp -- source onshape-ref --id SRC-PART --document <did> --version <vid> --element <eid> --part-number <pn> --revision A --out ref.json
npm run -s tdp -- sync check-publication --package part.tdp --onshape $CTX
```

Not yet run against a live account. Expect to adjust field handling once real responses are seen.

### With the CLI

```sh
L=samples/lab
CTX="--trust $L/trust-store.signed.json --anchors $L/anchors.json --authority $L/authority.signed.json --process $L/processes/printed-part-v1.json --evidence-dir $L/evidence --at 2026-11-12T13:00:00Z"

# Verify a ledger (exit 0 verified, 3 held, 1 rejected); with a retained checkpoint
npm run -s tdp -- record verify $L/ledgers/SN-0001.ledger.json --package $L/SYN-PH-2000_A.tdp $CTX --checkpoint $L/ledgers/SN-0001.checkpoint.json
npm run -s tdp -- record verify $L/ledgers/SN-0001-truncated.ledger.json --package $L/SYN-PH-2000_A.tdp $CTX --checkpoint $L/ledgers/SN-0001.checkpoint.json   # REJECTED: truncated
npm run -s tdp -- record verify $L/ledgers/invalid-skip.ledger.json --package $L/SYN-PH-2000_A.tdp $CTX                                               # REJECTED: forbidden step

# Record steps (the lab writes encrypted demo key files to samples/lab/keys/, gitignored)
export TDP_PASSPHRASE="lab-demo-passphrase (public, demo only)"
npm run -s tdp -- record new $L/SYN-PH-2000_A.tdp --item SYN-PH-2001@A --out /tmp/demo.ledger.json $CTX
echo '{"kind":"requirements-approval","requirements":[{"id":"REQ-001","version":1},{"id":"REQ-002","version":1},{"id":"REQ-003","version":1}]}' > /tmp/req.json
npm run -s tdp -- record add /tmp/demo.ledger.json --package $L/SYN-PH-2000_A.tdp --key $L/keys/req-owner.key.json \
  --action approve-requirements --role requirement-owner --outcome approved --reason "Reviewed (synthetic)" --data /tmp/req.json $CTX
npm run -s tdp -- record add /tmp/demo.ledger.json --package $L/SYN-PH-2000_A.tdp --key $L/keys/outsider.key.json \
  --action approve-requirements --role requirement-owner --outcome approved --reason "x" --data /tmp/req.json $CTX                      # DENIED, nothing signed

# A lot ledger (two units on separate tracks), checked against the newer rev B baseline
npm run -s tdp -- record verify $L/ledgers/LOT-0004.ledger.json --package $L/SYN-PH-2000_A.tdp $CTX --successor $L/SYN-PH-2000_B.tdp

# Evidence bundle (signed) and exchange (acknowledgements signed by the fixture PLM key)
npm run -s tdp -- evidence export $L/ledgers/SN-0001.ledger.json --package $L/SYN-PH-2000_A.tdp --out /tmp/bundle.json --key $L/keys/config-mgr.key.json $CTX
npm run -s tdp -- evidence verify /tmp/bundle.json --trust $L/trust-store.signed.json --anchors $L/anchors.json
cp $L/exchange/fixture-source.initial.json /tmp/fixture.json
npm run -s tdp -- sync export $L/ledgers/SN-0001.ledger.json --package $L/SYN-PH-2000_A.tdp --recipe $L/exchange/recipe.json --fixture /tmp/fixture.json --out /tmp/p.json $CTX
npm run -s tdp -- sync apply-fixture /tmp/p.json --fixture /tmp/fixture.json --out /tmp/a.json --key $L/keys/source-plm.key.json   # local fixture adapter only
npm run -s tdp -- sync apply-fixture /tmp/p.json --fixture /tmp/fixture.json --out /tmp/a2.json    # replay: all duplicate
npm run -s tdp -- sync import /tmp/p.json /tmp/a.json --trust $L/trust-store.signed.json --anchors $L/anchors.json --authority $L/authority.signed.json
npm run -s tdp -- sync check-publication --package $L/SYN-PH-2000_A.tdp --fixture /tmp/fixture.json $CTX
```

(In zsh, use an array for `CTX` or `${=CTX}`.) `--at` pins the evaluation time so the output is reproducible. Without it, the real clock is used, and once the fixture authority is older than 168 h, steps that need revocation freshness are reported as blocked. That is intended.

## What `samples/lab/` contains

| Path | What |
|---|---|
| `SYN-PH-2000_A.tdp`, `_B.tdp` | `tdp-manifest/0.2` surrogate baselines; B supersedes A (tab 6 → 8 mm) and carries over one stale geometry link |
| `anchors.json`, `trust-store*.json` | Lab root and its signed trust store (17 demo keys, 3 synthetic organizations) |
| `authority*.json` | Laboratory authority fixture (signed by the lab root): grants, sources, pinned processes, a revoked key, 168 h offline validity |
| `processes/` | Reference process and the first-article variant |
| `ledgers/` | SN-0001 (full path incl. failed build, delegation, accept, incorporation), SN-0002 (reject → NCR → scrap), SN-0003 (held), FAI-SN-0010 (second process), invalid and truncated ledgers, a checkpoint |
| `evidence/` | Synthetic evidence files referenced by hash |
| `exchange/` | Recipe, fixture source before and after, proposals, acknowledgements and a replay |
| `evidence-bundle-SN-0001.json` | Exported evidence bundle: identifiers, digests, policy/schema versions, separate statuses, traceability, expected vs actual results, limitations; no keys or secrets |

## Evidence and gap matrix

Legend: **Software**, implemented behavior verified by tests. **Simulated**, demonstrated on synthetic fixtures only. **External**, needs real-world evidence this repository can't produce, and must not be fabricated.

| | Software (implemented, tested) | Simulated (synthetic fixtures) | External dependency (not fabricated) |
|---|---|---|---|
| **P01 Identity and release** | `tdp-manifest/0.2` + engineering model with strict cross-checks; 0.1 packages unchanged; item vs occurrence identity; baseline, revision, effectivity, release declared separately; source-release record gated by authority `sources`; new baseline with `supersedes`, prior baseline and ledgers preserved; a known successor stops new work on the old baseline; possession ≠ authorization | Lab fixture PLM as release authority; Onshape-shaped surrogate references | The controlled design (Khaled); real Onshape document/version/release ids; confirmed Windchill access; who holds release authority |
| **P02 Process and build** | Suitability evaluation (fit, material, firmware, calibration, capability per characteristic) recomputed from inputs; gap review; manual queue/dispatch/complete records with file hash, settings, errors; failed build → requeue; several units per ledger on separate tracks; records signed from the CLI or the browser; 3MF export unchanged | H2C-LAB-01 capability ±0.15 mm, calibration records, firmware, job files and build logs are invented | Actual H2C (or other) runs, firmware version, a real capability study, real sliced `.gcode.3mf` and logs |
| **P03 Inspection and disposition** | Units, limits, guard-banded and simple-acceptance rules, uncertainty, TUR; indeterminate on missing or incompatible evidence; NCR; disposition separate from measurement, by an independent authorized role; closure with incorporation into an occurrence | All measurements, instruments, uncertainty budgets and calibration certificates | Real tolerances from the design; calibrated instruments and certificates; real measurements; an approved decision rule for the program |
| **P04 Invalid transitions** | Gate denies before signing (CLI exit 1) and rejects validly signed forbidden records on verification; skipped steps, missing evidence, false outcome claims, stale geometry | Invalid ledgers built on purpose | None |
| **P05 Authorization** | Workflow grants separate from signing roles; organization binding; delegation (one level, never self); revoked keys; expired authority; process pinned by digest; bounded CIP (operation, org, role, units, window, policy version, use limits); offline freshness window | Lab authority fixture, demo keys with public seeds | Real role assignments and delegations; the program's authority (PLM/IdP); hardware-backed keys; an agreed offline validity window |
| **P06 Integrity and recovery** | Edited, removed and reordered records detected; truncation and fork detected against a retained checkpoint; altered evidence → held; tampered baseline → no binding; full re-verification from retained files; signed evidence bundles fail after any edit | | An independent checkpoint keeper (receiving org or custody log); trusted timestamps if wall-clock time matters |
| **P07 Exchange boundary** | Recipe, adapter interface, local fixture adapter: create, update with expected version, no-change, conflict (and dependent updates refused), unsupported, held lossy, duplicate replay, id reuse rejected, publication version check; signed acknowledgements; acknowledgements never alter baselines. Read-only Onshape adapter (CLI): request signing, publication check, reference capture, tested against a fake transport | Fixture source system and its objects | Running the Onshape adapter against a live account (needs API keys and a real document); Windchill adapter (not implemented); write-back to any source system |
| **P08 Measured performance** | Verification timings measured each run (`demo-results.md`), including a 681-record, 45-unit ledger (about 0.4 ms per record, linear) | | Physical build time, cycle time, dimensional capability and yield from real runs |

## Remaining dependencies

**From Khaled:** the controlled design of the actual printed component (CAD source, drawing, requirement set, characteristics with real limits and decision rules), and confirmation of the authoritative source system and release states.

**From Nick (or the lab):** printer identity and firmware; a material lot; a capability study and calibration records; calibrated measuring instruments and certificates; real builds and measurements; named people, keys and organizations for each workflow role; an agreed offline validity window; and, for Windchill, confirmed access.

Once these exist, they replace the synthetic fixture inputs. The engine, schemas and verification don't change.
