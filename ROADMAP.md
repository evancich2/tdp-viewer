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

## Next: 3D viewer
- [ ] Interactive 3D STEP viewer (three.js): orbit, part tree, measure
- [ ] Pick a part in 3D to highlight it in the BOM, and the reverse
- [ ] Title-block metadata panel beside the drawing
- [ ] Load pdf.js lazily to shrink the main bundle

## 3D printing
- [ ] Print settings carried in the package (material, infill, orientation) and written into the 3MF
- [ ] Bambu LAN print bridge: a separate local CLI that uploads a sliced `.gcode.3mf` to a printer in LAN mode (FTPS + MQTT, access code) and reports status; kept out of the browser app so the viewer stays network-free
- [ ] Slicing through the Bambu Studio CLI from the bridge
- [ ] STL export for other slicers
- [ ] Rebuild occt-import-js with `-sDYNAMIC_EXECUTION=0` to drop the STEP worker's `unsafe-eval`

## Packaging tools
- [ ] CLI `keygen`, `pack` and `sign` commands (private keys never written unencrypted)
- [ ] Multi-party signing: add signatures to an existing package without rebuilding it
- [ ] Signed trust stores, chained to an organizational root key

## Configuration control
- [ ] Revision diff: compare two TDPs (files added, removed or changed; BOM changes)
- [ ] Effectivity and supersession fields in the manifest
- [ ] Policy editor: required roles, allowed media types, limits

## Progressive web app
- [ ] Installable PWA with an offline app shell (no TDP content is ever cached)
- [ ] Integrity-pinned service worker updates
- [ ] Open `.tdp` files straight from the OS (File Handling API in Chromium)

## Hardening
- [ ] Fuzz tests for the archive reader and schemas
- [ ] Broaden the end-to-end tests (rejected-package cases, keyboard use)
- [ ] Signed audit-log export
- [ ] Optional hardware-backed signing (WebAuthn, PIV/CAC smart cards)

## Later
- [ ] PMI display: dimensions and tolerances embedded in STEP AP242 models
- [ ] Redline markup stored as signed overlays, never modifying the original
- [ ] PLM import and export adapters
