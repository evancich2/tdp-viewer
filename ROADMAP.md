# Roadmap

Each milestone becomes a set of GitHub issues.

## TRL 4 demonstration (Phase I)

Goal: one printed part governed end to end against one released baseline, with every step a signed record and invalid steps rejected with an auditable reason. The viewer stays network-free. Status of the software increment, with its evidence/gap matrix: [docs/laboratory-demo.md](docs/laboratory-demo.md).

Decided: the source PLM governs release (Onshape first, Windchill preferred later); until integrated, a labeled laboratory authority fixture stands in. Workflow records live in a ledger beside the package; the baseline is never modified. Package-signing roles (`author`, `checker`, `approver`, `release`) stay separate from workflow roles.

### Done in software (synthetic fixtures)
- [x] `tdp-manifest/0.2` with a versioned engineering model (items, occurrences, requirements, characteristics, artifacts, geometry links with stability, sources, effectivity, supersedes); 0.1 unchanged
- [x] Authority configuration: workflow grants, organizations, source release authority, pinned processes, revocation, offline validity window; root-signed
- [x] Signed, hash-chained workflow records bound to the baseline digest; checkpoints for truncation
- [x] Configurable process definitions; reference process and a first-article variant on the same engine
- [x] Bounded authorization (CIP); one-level delegation; fail-closed gates
- [x] Process suitability (fit, material, firmware, calibration, capability) with engineering gap review
- [x] Manual queue and build records; inspection with documented decision rules, units and uncertainty; NCR; disposition; closure with incorporation
- [x] Publishing recipe, adapter interface, local fixture adapter, idempotent transactions, acknowledgements
- [x] CLI `record`, `evidence export`, `sync`, `authority sign`; viewer workflow panels; evidence bundle

### Needs real inputs (not to be fabricated)
- [ ] The controlled design of the demo part and its real requirement set and tolerances
- [ ] Onshape source references for it; decision on Windchill access
- [ ] Printer identity and firmware, capability study, calibration and instrument certificates
- [ ] Actual builds on the H2C and real measurements, run through the workflow and kept as evidence
- [ ] Named people, keys and organizations for each workflow role

### Next in software
- [ ] Onshape adapter (read release state and versions through the `SourceAdapter` interface), then Windchill
- [ ] Merkle custody log with exchanged tree heads (replaces checkpoints as the truncation defense); RFC 3161 time-stamps
- [ ] Bambu LAN bridge as a separate CLI producing automated build records (needs LAN-only and Developer Mode decisions)
- [ ] Allow 3MF as a process-input artifact class in packages; print settings carried into the 3MF
- [ ] Hardware-backed keys for workflow records

## Done: v0.1 foundation
- [x] Package format: signed manifest, detached Ed25519 signatures, trust store
- [x] Zero-trust verification core (archive limits, strict schemas, role-based signatures with separation of duties, content sniffing, BOM checks)
- [x] `PackageSession`: verified, audited access to file bytes
- [x] Hash-chained audit log with export
- [x] React UI: trust store, package open, checks, BOM tree, file list, text preview
- [x] CLI verifier
- [x] Synthetic sample packages, including a tampered one
- [x] Strict production CSP with no network access

## Done: v0.2 drawings and printing
- [x] PDF drawing viewer: pdf.js in a per-document worker; pages, zoom, pan, rotate; no annotations or scripts
- [x] STEP meshing with OpenCascade (occt-import-js) in a throwaway worker
- [x] 3MF export for Bambu Studio, with provenance metadata and watertight checks, governed by policy
- [x] Real synthetic sample geometry (STEP B-rep writer) and dimensioned sample drawings
- [x] Per-path CSP headers and `_headers` file; end-to-end test in real Chrome

## Done: v0.3 3D viewer
- [x] Interactive 3D STEP viewer (three.js): orbit, preset views, click to select, show/hide solids, sizes
- [x] Load pdf.js and three.js lazily (main bundle 694 KB to 264 KB)

## Next
- [ ] Pick a part in 3D to highlight it in the BOM, and the reverse (needs assembly structure from STEP)
- [ ] Measure tool: point-to-point distance in the 3D view
- [ ] Title-block metadata panel beside the drawing

## 3D printing
- [x] Printer profiles with a build-volume fit check (Bambu Lab H2C)
- [ ] Print settings carried in the package (material, infill, orientation) and written into the 3MF
- [ ] Bambu LAN print bridge for the H2C: a separate local CLI that uploads a sliced `.gcode.3mf` over FTPS (port 990) and starts it over MQTT (port 8883) with the printer's access code; likely needs LAN-only mode plus Developer Mode on the printer; kept out of the browser app so the viewer stays network-free
- [ ] Slicing through the Bambu Studio CLI from the bridge
- [ ] STL export for other slicers
- [ ] Rebuild occt-import-js with `-sDYNAMIC_EXECUTION=0` to drop the STEP worker's `unsafe-eval`

## Done: v0.4 packaging tools
- [x] CLI `keygen` with scrypt + AES-256-GCM encrypted key files
- [x] `trust add` / `trust revoke`
- [x] `pack` a folder with a `tdp-package.json` spec
- [x] `sign`: multi-party, one signature at a time; checks contents and role before signing

## Done: v0.7 signed trust stores
- [x] Organization root keys (`keygen --roles root`), anchors file, `trust anchor` and `trust sign`
- [x] Viewer and CLI accept only root-signed trust stores once a root is pinned
- [x] Serial numbers with rollback protection; expiry on signed stores

## Packaging tools: next
- [ ] Hardware-backed keys (PIV/CAC smart card, YubiKey) for signing

## Done: v0.5 revision compare
- [x] Revision diff in the CLI (`tdp diff`) and UI: package fields, parts, and files (added, removed, changed, moved, revised)
- [x] Sample rev C package with a change order

## Chain of custody ([design](docs/chain-of-custody.md))
- [ ] Signed custody events (packaged, signed, transferred, received, inspected, printed), hash-linked and carried in the package
- [ ] Viewer: verify and show the custody timeline for a package
- [ ] CLI: `tdp custody add` to record a handoff with your key
- [ ] Merkle-tree custody log with signed tree heads, inclusion and consistency proofs (Certificate Transparency style)
- [ ] Exchange and compare signed tree heads between organizations; flag any inconsistency
- [ ] Record 3D-print exports as custody events
- [ ] Optional anchoring of tree heads: RFC 3161 timestamps, public transparency logs, or a blockchain where required (root hash only, never package data)

## Configuration control
- [x] Drawing overlay compare for revised drawings, with changed areas boxed
- [ ] Multi-page drawing compare
- [ ] Geometry compare for revised models (volume, bounding box, overlay)
- [ ] Change-order (ECO) metadata in the manifest, linked to the parts it affects
- [ ] Effectivity and supersession fields in the manifest
- [ ] Policy editor: required roles, allowed media types, limits

## Done: v0.6 progressive web app
- [x] Installable PWA: manifest, icons, install button
- [x] Offline app shell via a hand-written service worker; no TDP content is ever cached
- [x] Integrity-pinned updates: every file checked against build-time SHA-256 before caching; user-triggered activation
- [x] Open `.tdp` files from the OS (File Handling API in Chromium)
- [x] Opt-in remembered trust store with fingerprint and audit entry
- [x] End-to-end PWA test: offline use, update prompt, tampered-file refusal

## Progressive web app: next
- [ ] Signed releases: verify app updates against a release key, not just the server
- [ ] Persistent audit log on the device (append-only, exportable), opt-in

## Hardening
- [x] Fuzz tests: mutated packages, mangled manifests, zip bombs, path traversal, case collisions
- [ ] Broaden the end-to-end tests (rejected-package cases, keyboard use)
- [ ] Signed audit-log export

## Later
- [ ] PMI display: dimensions and tolerances embedded in STEP AP242 models
- [ ] Redline markup stored as signed overlays, never modifying the original
- [ ] PLM import and export adapters
