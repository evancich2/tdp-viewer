# Roadmap

Each milestone becomes a set of GitHub issues.

## TRL 4 demonstration (Phase I)

Goal: one bracket governed end to end — requirements, CAD release, process match, queue, print on the Bambu Lab H2C, inspection and disposition — with every step recorded against one package identity and revision, and at least one invalid step rejected with an auditable reason. The package's signed event log acts as the PLM for that one package: no server, and the viewer stays network-free.

Open decisions: the demo part and its requirement set; the package event log as release authority (vs. Onshape release management); H2C firmware and whether Developer Mode is acceptable.

### Phase A: governance core
- [ ] Lifecycle state machine: draft → requirements approved → CAD released → process matched → planned → queued → printing → printed → inspected → dispositioned; allowed transitions, required role and evidence for each
- [ ] Signed lifecycle events carried in the package (first step of [chain of custody](docs/chain-of-custody.md), without the Merkle log): actor, organization, role, time, reason, result; hash-linked to the previous event and bound to the manifest digest
- [ ] CLI `tdp event add`; viewer verifies events and shows the timeline
- [ ] Organization on trusted keys (optional CAGE code)
- [ ] Roles: requester, design engineer, requirement owner, approver, planner, operator, inspector, auditor (replacing author/checker/approver/release)
- [ ] Policy permits or denies each action by role, organization and lifecycle state
- [ ] Demo: one allowed and one denied transition (e.g. wrong revision, missing approval, process mismatch) with the reason recorded

### Phase B: requirements and process fit
- [ ] Requirements in the manifest: function, interfaces, material, datums, acceptance criteria, requirement owner; approval gate before release
- [ ] Process registry: printer, firmware, material, slicer profile, orientation, geometry/tolerance envelope, calibration status, evidence
- [ ] Requirements-to-process match that passes or blocks with listed gaps (grows out of the build-volume fit check)
- [ ] Work instructions and print settings in the package, written into the 3MF (replaces the 3D-printing item below)

### Phase C: build and inspection
- [ ] Manual queue: record queued, dispatched, job ID and timestamps as manual events
- [ ] Bambu LAN bridge (separate CLI): FTPS upload and MQTT start/status, pinned firmware, job ID correlated to the package revision (replaces the 3D-printing item below)
- [ ] Serial/lot assignment
- [ ] Inspection intake: inspector and organization, instrument and calibration, measurements against acceptance criteria, decision rule, pass/fail, disposition

### Phase D: evidence and end-to-end run
- [ ] Onshape source reference in the manifest: document, element, version, release state (entered at pack time; REST pull later)
- [ ] Real single-part bracket from Onshape as the demo package
- [ ] Allow 3MF as a process-input file, marked as not the authoritative definition
- [ ] Effectivity and supersession fields (from configuration control below)
- [ ] Evidence view in the viewer: requirements → release → process → job → inspection → disposition for one revision
- [ ] CLI `tdp evidence`: export the TRL 4 evidence bundle
- [ ] Run the full workflow on the H2C and keep the artifacts and logs

Deferred until after the demo: signed app releases, multi-page and geometry compare, Merkle custody log and anchoring, hardware-backed keys, measure tool, BOM↔3D picking, title-block panel, STL export, rebuilding occt without `unsafe-eval`.

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
