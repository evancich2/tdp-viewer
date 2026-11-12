# Roadmap

Each milestone becomes a set of GitHub issues.

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

## Packaging tools: next
- [ ] Signed trust stores, chained to an organizational root key
- [ ] Hardware-backed keys (PIV/CAC smart card, YubiKey) for signing

## Done: v0.5 revision compare
- [x] Revision diff in the CLI (`tdp diff`) and UI: package fields, parts, and files (added, removed, changed, moved, revised)
- [x] Sample rev C package with a change order

## Configuration control
- [ ] Side-by-side drawing compare with pixel overlay for revised drawings
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
- [ ] Fuzz tests for the archive reader and schemas
- [ ] Broaden the end-to-end tests (rejected-package cases, keyboard use)
- [ ] Signed audit-log export

## Later
- [ ] PMI display: dimensions and tolerances embedded in STEP AP242 models
- [ ] Redline markup stored as signed overlays, never modifying the original
- [ ] PLM import and export adapters
