# Zero-trust design

TDP Viewer treats every package as hostile until proven otherwise, and keeps re-proving it. This page maps zero-trust principles to the code.

## Principles

| Principle | How it's applied | Code |
|---|---|---|
| Never trust, always verify | A package is `trusted` only if *every* check passes; there is no partial trust. File bytes are re-hashed on every open. | `verifyPackage`, `PackageSession.openFile` |
| Explicit trust anchors | Signer keys come from an operator-supplied trust store. A key's id is derived from its public key, so it can't be spoofed. | `loadTrustStore`, `keyIdFor` |
| Least privilege | Keys are authorized per role (`author`, `checker`, `approver`, `release`) and only within a validity window. | `checkSignature` |
| Separation of duties | Required roles must be signed by distinct keys. One person can't author and approve. | `verifyPackage` step 3 |
| Default deny | Strict schemas reject unknown fields; unlisted files, disallowed media types and mismatched content fail. | `schema.ts`, `policy.ts` |
| Assume breach | Size, ratio, entry-count and path checks run before and after decompression, since zip headers are attacker-controlled. | `readArchive`, `checkPath` |
| Continuous monitoring | Every load, verdict, denial, open and export goes into a hash-chained audit log. | `AuditLog` |
| Minimize attack surface | No backend, no network: production CSP sets `connect-src 'none'`. | `vite.config.ts` |

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

## Threats not yet covered

These are tracked in [ROADMAP.md](../ROADMAP.md):

- Trust store distribution and integrity (today the operator loads a JSON file; it should itself be signed by an organizational root).
- Online revocation status (revocation is a flag in the trust store; there's no live check, by design for offline use).
- Parser hardening for PDF and STEP rendering, which should run in a sandboxed worker.
- Service-worker update integrity once the app is a PWA.
