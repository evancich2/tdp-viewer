# Experimental feasibility laboratory harness

Added November 19, 2026 against base `200b6ccf1ceaf1a2f1047788d8925a643a2bad83`.
This is evidence-generation tooling, not a production transport protocol or
an accredited cryptographic boundary. The existing viewer/verifier API is unchanged.

## Reproduce

Use the repository's pinned Node dependencies and a compatible local Chrome:

```sh
node --import tsx tools/feasibility-lab.ts .lab-evidence
node --import tsx tools/feasibility-browser.ts .lab-evidence
node node_modules/vitest/vitest.mjs run tests/lab-envelope.test.ts --cache=false
node node_modules/typescript/bin/tsc --noEmit
node node_modules/oxlint/bin/oxlint tools/lab-envelope.ts tools/feasibility-lab.ts tools/feasibility-browser.ts tests/lab-envelope.test.ts --deny-warnings
```

The first command creates fresh temporary test keys. `.lab-evidence/.private/`
contains a recipient private key, must stay ignored, and must never be published.
Generated trust stores expire; reproduce to create a current set. Do not reuse
these keys or local settings for real engineering data. The browser command
builds and starts a loopback Vite preview for the run, then stops it.

## What ran

Unchanged public NIST CTC 01 and STC 06 AP 242 models tessellated into watertight
geometry. STC 06 rendered through the existing WebGL browser after admission
of a recovered signed package. See `samples/public-nist/README.md` for sources,
SHA-256 hashes and acknowledgment. This does not prove semantic-PMI interpretation.

Two local Node processes emulate sender A and recipient B, using separate signed
trust stores, different pinned roots and an explicit receiver allowlist of the
sender author/approver. Ed25519 signs the envelope and package; a fresh
AES-256-GCM key protects the payload, wrapped with recipient RSA-3072 OAEP SHA-256.
The receiver independently verifies the envelope, decrypts, checks byte hashes,
and uses the existing signed-package verifier before opening the model.

Seven integration negatives reject replay, expiry, changed ciphertext, changed
recipient metadata, wrong recipient key, wrong sender pin and revoked author.
Sixteen unit tests cover valid admission, malformed/oversize input, signature,
AAD/tag binding, trust, expiry/replay, key profiles and random key/IV/ID generation.

Final executed results: 16/16 new cases passed; full suite 178 passed, 23 skipped,
zero failed. All 23 skipped cases are the existing simulated printer-bridge
group; they are not counted as passing or as physical printer tests. Typecheck
and lint of the four new TypeScript files passed. No new dependency was added.
Initial assertion fixes distinguished Buffer/Uint8Array byte equality and raw
(8,555) versus welded (8,548) triangle counts; final reruns passed.

## Limits

Both processes run on one host and exchange local file artifacts. They are not
live EEL and ThinkHARI services or separate OS security enclaves. Replay state is
an in-memory set, not a persistent ledger; simultaneous-receive protection and
operational key custody are not implemented. Do not expose this harness as a
network service. No claim of FIPS validation, production security approval,
fleet-scale performance, JT support or standards conformance follows.

Only public model data and disposable lab credentials are used. Public results,
screenshots and manifests may be shared; private test keys are excluded.
