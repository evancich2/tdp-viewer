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

## Next: viewers
- [ ] PDF drawing viewer with pdf.js, rendered in a Web Worker: multi-page, zoom, pan
- [ ] Title-block metadata panel beside the drawing
- [ ] 3D STEP viewer: three.js with occt-import-js (OpenCascade WASM) in a worker; orbit, part tree
- [ ] Pick a part in 3D to highlight it in the BOM, and the reverse
- [ ] Replace placeholder sample STEP files with real synthetic geometry

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
- [ ] Playwright end-to-end tests
- [ ] Signed audit-log export
- [ ] Optional hardware-backed signing (WebAuthn, PIV/CAC smart cards)

## Later
- [ ] PMI display: dimensions and tolerances embedded in STEP AP242 models
- [ ] Redline markup stored as signed overlays, never modifying the original
- [ ] PLM import and export adapters
