# TDP Viewer

A zero-trust viewer for engineering **Technical Data Packages** (TDPs): the drawings, 3D models, bills of materials and revision data that define a part or assembly.

TDP Viewer opens a `.tdp` package in the browser and refuses to show anything until it has verified the whole package: every file's SHA-256 digest, a signed manifest, and signatures from keys *you* trust in the roles your policy requires. Nothing is uploaded; the app makes no network requests at all.

**Who it's for:** engineers, configuration managers and suppliers who receive or hand off TDPs and need to know a package is complete, unaltered and properly released before they build from it.

> Status: early development. Verification, the audit log and the package format work today. The PDF drawing viewer and 3D STEP viewer are next; see [ROADMAP.md](ROADMAP.md).

## Zero trust, concretely

- **Nothing in a package is trusted by default.** Everything not explicitly allowed by the policy is rejected: unknown fields, unlisted files, unexpected media types.
- **Trust anchors come from you, not the package.** You load a trust store of signer keys; a package can't vouch for itself.
- **Separation of duties.** The default policy requires both an `author` and an `approver` signature, from *different* keys, each authorized for that role and valid at signing time and now. Revoked keys fail.
- **Verify on every access.** UI code can only read file bytes through `PackageSession.openFile`, which re-checks the digest each time and denies everything from a rejected package.
- **Hostile-input handling.** Zip-bomb limits, path-traversal and duplicate-name checks, strict schemas, and content sniffing (a "PDF" must start with `%PDF-`).
- **Every action is recorded.** A hash-chained audit log covers each load, verdict, denial and file open, and can be exported.
- **No network, strict CSP.** Production builds ship `default-src 'none'; connect-src 'none'`.

Details: [docs/zero-trust.md](docs/zero-trust.md) · Package format: [docs/package-format.md](docs/package-format.md)

## Built with

TypeScript, React, Vite, [zod](https://zod.dev) for strict schemas, [fflate](https://github.com/101arrowz/fflate) for zip, and the browser's built-in WebCrypto (SHA-256, Ed25519). Tests use Vitest. The same verification core runs in the browser and in Node.

## Run it

Requires Node 20 or newer.

```sh
npm install
npm run dev          # open the printed URL
```

In the app, click **Use demo keys**, then open `samples/sample.tdp` (trusted) or `samples/tampered.tdp` (one drawing altered after signing, so it's rejected).

Other commands:

```sh
npm test             # unit tests
npm run build        # typecheck + production build into dist/
npm run sample       # regenerate the sample packages with fresh demo keys
npm run tdp -- verify samples/sample.tdp --trust samples/trust-store.json
```

The CLI exits 0 for a trusted package and 1 for a rejected one, so it can gate a CI pipeline or a receiving-inspection script.

## Sample data

Everything in `samples/` is synthetic: made-up part numbers, placeholder geometry, and demo keys whose private halves were discarded when they were generated. Don't put real or export-controlled technical data in this repository.

## License

[Apache License 2.0](LICENSE).
