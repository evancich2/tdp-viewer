# TDP Viewer

A zero-trust viewer for engineering **Technical Data Packages** (TDPs): the drawings, 3D models, bills of materials and revision data that define a part or assembly.

TDP Viewer opens a `.tdp` package in the browser and refuses to show anything until it has verified the whole package: every file's SHA-256 digest, a signed manifest, and signatures from keys *you* trust in the roles your policy requires. Nothing is uploaded; the app makes no network requests at all.

**Who it's for:** engineers, configuration managers and suppliers who receive or hand off TDPs and need to know a package is complete, unaltered and properly released before they build from it.

> Status: early development. Verification, the audit log, the drawing and 3D viewers and 3D-print export work today; see [ROADMAP.md](ROADMAP.md) for what's next.

## Features

- **Verify** a package against your trust store and policy, with a per-check report.
- **View drawings:** PDF pages rendered with pdf.js in an isolated worker, with zoom (buttons or Ctrl/⌘ + scroll), pan by dragging, rotate and multi-page navigation. Only page content is drawn: no links, forms, annotations or scripts.
- **View 3D models:** STEP files meshed by OpenCascade in a throwaway worker and shown with three.js: orbit, preset views (iso, top, front, right), click a solid to select it, show or hide solids, and see each solid's size.
- **Print a part:** turn a verified STEP model into a 3MF that [Bambu Studio](https://bambulab.com/en/download/studio) opens directly, ready to slice and send to a Bambu Lab printer (or any 3MF slicer). The model is meshed with OpenCascade in a throwaway worker, checked to be watertight, and stamped with its part number, revision and the package and source digests, so a printed part traces back to the exact signed package.
- **Browse** the BOM tree and file list; every file open and export goes into the audit log.

## Zero trust, concretely

- **Nothing in a package is trusted by default.** Everything not explicitly allowed by the policy is rejected: unknown fields, unlisted files, unexpected media types.
- **Trust anchors come from you, not the package.** You load a trust store of signer keys; a package can't vouch for itself.
- **Separation of duties.** The default policy requires both an `author` and an `approver` signature, from *different* keys, each authorized for that role and valid at signing time and now. Revoked keys fail.
- **Verify on every access.** UI code can only read file bytes through `PackageSession.openFile`, which re-checks the digest each time and denies everything from a rejected package.
- **Hostile-input handling.** Zip-bomb limits, path-traversal and duplicate-name checks, strict schemas, and content sniffing (a "PDF" must start with `%PDF-`).
- **Every action is recorded.** A hash-chained audit log covers each load, verdict, denial and file open, and can be exported.
- **No network, strict CSP.** Production builds ship `default-src 'none'; connect-src 'none'`.

Details: [docs/zero-trust.md](docs/zero-trust.md) · Package format: [docs/package-format.md](docs/package-format.md) · Building packages: [docs/packaging.md](docs/packaging.md)

## Built with

TypeScript, React, Vite, [zod](https://zod.dev) for strict schemas, [fflate](https://github.com/101arrowz/fflate) for zip, [pdf.js](https://mozilla.github.io/pdf.js/) for drawings, [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade compiled to WebAssembly, LGPL-2.1, used unmodified) for STEP, [three.js](https://threejs.org) for 3D, and the browser's built-in WebCrypto (SHA-256, Ed25519). Tests use Vitest, and the end-to-end check drives a real Chrome through playwright-core. The same verification core runs in the browser and in Node.

## Run it

Requires Node 20 or newer.

```sh
npm install
npm run dev          # open the printed URL
```

In the app, click **Use demo keys**, then open `samples/sample.tdp` (trusted) or `samples/tampered.tdp` (one drawing altered after signing, so it's rejected).

### Printing on a Bambu Lab printer

1. Open a trusted package and select a `.stp` model.
2. Click **Export 3MF for Bambu Studio**. The browser saves `<part>_<rev>.3mf`.
3. Open the 3MF in Bambu Studio, pick the printer, plate and filament, slice, and print over LAN or cloud as usual.

The viewer itself never talks to the printer; see the roadmap for a separate LAN print bridge.

Other commands:

```sh
npm test             # unit tests
npm run e2e          # build, then drive the app in headless Chrome (needs Google Chrome)
npm run build        # typecheck + production build into dist/
npm run sample       # regenerate the sample packages with fresh demo keys
npm run tdp -- verify samples/sample.tdp --trust samples/trust-store.json
```

### Making your own packages

The `tdp` CLI creates passphrase-protected signing keys, manages the trust store, packs a folder into a `.tdp`, and adds signatures one signer at a time. See [docs/packaging.md](docs/packaging.md). `tdp verify` exits 0 for a trusted package and 1 for a rejected one, so it can gate a CI pipeline or a receiving-inspection script.

## Deploying

`npm run build` writes a static site to `dist/`. Serve it with the Content-Security-Policy as an **HTTP header**, not just the `<meta>` tag, because Web Workers ignore `<meta>` CSP. `dist/_headers` has the exact headers (Netlify and Cloudflare Pages read it as is), including the one relaxation: the STEP worker may `eval`, which OpenCascade's glue code needs.

## Sample data

Everything in `samples/` is synthetic: made-up part numbers, simple extruded geometry, and demo keys whose private halves were discarded when they were generated. Don't put real or export-controlled technical data in this repository.

## License

[Apache License 2.0](LICENSE).
