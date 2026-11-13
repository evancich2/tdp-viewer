# Zero-trust design

TDP Viewer treats every package as hostile until proven otherwise, and keeps re-proving it. This page maps zero-trust principles to the code.

## Principles

| Principle | How it's applied | Code |
|---|---|---|
| Never trust, always verify | A package is `trusted` only if *every* check passes; there is no partial trust. File bytes are re-hashed on every open. | `verifyPackage`, `PackageSession.openFile` |
| Explicit trust anchors | Signer keys come from an operator-supplied trust store. A key's id is derived from its public key, so it can't be spoofed. Optionally an organization root signs the trust store; once a root is pinned, unsigned stores are refused, and serial numbers block rollback to an older store. | `loadTrustStoreFile`, `keyIdFor` |
| Least privilege | Keys are authorized per package-signing role (`author`, `checker`, `approver`, `release`) and only within a validity window. Engineering workflow roles are a separate grant in the operator's authority configuration; a signature grants neither manufacturing permission nor proof of source release. | `checkSignature`, `resolveRole` |
| Authority from configuration, never from data | A workflow record can't grant its signer authority. Roles come from grants (or a one-level delegation under a grant that allows it), organizations from the trust store, process rules from a definition pinned by digest. | `authority.ts`, `evaluateRecord` |
| Keys stay with their holder | The viewer can sign workflow records, but only with a key file the user opens: it is decrypted in memory, imported non-extractable, and never stored or sent. The CLI keeps private keys encrypted at rest. | `keyfile.ts`, `RecordStepForm` |
| Network only where needed, never in the viewer | The read-only Onshape adapter runs in the CLI with credentials from the environment. The browser app keeps `connect-src 'none'`. | `tools/onshape.ts`, `vite.config.ts` |
| Fail closed offline | Missing grant, revoked key, expired authority, stale policy, unpinned process, missing evidence or a CIP that doesn't cover the unit all deny. Revocation-sensitive steps are denied once the authority configuration is older than its offline validity window. | `evaluateRecord`, `freshnessProblem` |
| Separation of duties | Required roles must be signed by distinct keys. One person can't author and approve. | `verifyPackage` step 3 |
| Default deny | Strict schemas reject unknown fields; unlisted files, disallowed media types and mismatched content fail. | `schema.ts`, `policy.ts` |
| Assume breach | Size, ratio, entry-count and path checks run before and after decompression, since zip headers are attacker-controlled. | `readArchive`, `checkPath` |
| Continuous monitoring | Every load, verdict, denial, open and export goes into a hash-chained audit log. | `AuditLog` |
| Minimize attack surface | No backend, no network: production CSP sets `connect-src 'none'`. | `vite.config.ts` |
| Isolate parsers | PDF and STEP bytes are parsed in workers, never on the page. The STEP worker is created per model and terminated afterwards. | `DrawingViewer`, `mesh/client.ts` |
| Govern data leaving the viewer | 3D-print export is a separate policy decision, accepts only verified STEP models, refuses meshes that aren't watertight, and logs the output's digest. | `exportForPrint`, `policy.print` |

## What a signature covers

Each signer signs:

```
tdp-signature/0.1
<role>
<signedAt>
<sha256 of tdp-manifest.json bytes>
```

Binding the role and time means a signature can't be relabeled as a different role or replayed onto another manifest. The manifest lists every other file's digest, so one signature covers the whole package.

## Verification order

1. **Archive:** limits, paths, duplicates.
2. **Manifest:** strict parse.
3. **Signatures:** trusted key, role, validity window, not revoked, valid Ed25519, required roles covered by distinct keys.
4. **Package validity:** not created in the future, not expired.
5. **Contents:** exactly the listed files; size, digest, allowed media type and content sniffing for each.
6. **BOM:** file references resolve, parents exist, no cycles.
7. **Engineering model** (0.2 only): strict parse and cross-check against the manifest; stale geometry links are flagged for review.

Workflow ledgers are verified separately against a trusted 0.2 baseline (`verifyLedger`): chain, signature, identity and organization binding, baseline and item binding, policy binding, role, transition, evidence hashes, payload semantics. See [engineering-workflow.md](engineering-workflow.md).

## Drawings

pdf.js parses each PDF in its own worker, destroyed when the drawing closes. It is configured to fetch nothing (`useWorkerFetch: false`, no cMap or font URLs, no WASM decoders), and pages are drawn to a canvas with annotations disabled, so links, forms and embedded JavaScript never become live.

## 3D-print export

A STEP model becomes a 3MF only through `exportForPrint`, which:

1. checks `policy.print.allowExport` and that the file is a STEP model;
2. reads it through `PackageSession.openFile`, re-verifying its digest;
3. meshes it with OpenCascade in a fresh worker, welds the mesh, and checks the triangle limit and that every solid is watertight;
4. writes the part number, revision, package id, manifest digest and source digest into the 3MF metadata;
5. logs the export with the 3MF's SHA-256.

Any refusal is logged as a `deny`.

### The one CSP relaxation

OpenCascade's Emscripten glue builds functions at runtime, so the STEP worker is served with `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'`. The page itself is not. The worker has no DOM, `connect-src 'none'`, its WASM is inlined so it loads nothing, and it only receives bytes that already passed verification. Rebuilding occt-import-js with `-sDYNAMIC_EXECUTION=0` would remove the exception (see the roadmap).

Workers take their CSP from HTTP headers only, so a deployment must send the headers in `dist/_headers`.

## Progressive web app

The service worker (`src/pwa/service-worker.js`, about 60 lines of plain JavaScript) is the only code allowed to make network requests, and only to the app's own origin.

- **Only app files are cached.** The build writes the list of files into `sw.js`. Packages and trust stores are opened from local files and never pass through the service worker or any cache.
- **Integrity-pinned updates.** Each file's SHA-256 is fixed into `sw.js` at build time. Installing a version downloads every file and checks its digest before caching anything; one mismatch fails the install and the previous version keeps running. The app is therefore never a mix of two versions, and a file altered on the server, a CDN or a proxy without a matching `sw.js` is refused.
- **User-controlled activation.** A new version waits until the user clicks **Reload to update**.
- **Headers preserved.** Cached responses keep their HTTP headers, so the STEP worker's CSP still applies offline.

What it does *not* protect against: the root of trust for the code is still `sw.js` served from the origin over HTTPS. Whoever controls the server can publish a new `sw.js` with new digests. Signing releases with a key pinned on first install would close that gap, but browsers replace service workers on their own, so it needs a different mechanism (see the roadmap).

### Remembered trust store

Remembering the trust store is opt-in. It is stored in the browser's site storage, revalidated (schema and key ids) each time it's loaded, shown with a fingerprint of its exact bytes, and logged in the audit log as a `trust` event. Unticking the box deletes it. Anything able to run script on the origin could alter it; the strict CSP is what prevents that.

## Threats not yet covered

- Trusted time: record and signature times are the signer's claim; nothing is timestamped by a third party.
- Truncated ledgers: dropping the newest records is detected only against an independently retained checkpoint.

These are tracked in [ROADMAP.md](../ROADMAP.md):

- Online revocation status (revocation is a flag in the trust store; there's no live check, by design for offline use).
- Fuzzing the PDF and STEP parsers (the verifier itself is fuzzed: `tests/fuzz.test.ts`).
- Chain of custody across organizations (designed in [chain-of-custody.md](chain-of-custody.md)).
- Release signing for app updates (today the server's `sw.js` is the root of trust for code).
- The `unsafe-eval` exception in the STEP worker.
- What happens to a 3MF after export: the slicer and printer are outside the viewer's control.
