# Package format (`tdp-manifest/0.1` and `0.2`)

Two manifest versions are accepted, selected by the `schema` field; anything else is rejected.

- `tdp-manifest/0.1`: the original format, verified exactly as before. No engineering model is inferred.
- `tdp-manifest/0.2`: identical, plus one required field `"engineering": { "path": "engineering/model.json", "schema": "tdp-engineering/0.1" }` naming a listed `application/json` file that holds the canonical engineering model ([engineering-workflow.md](engineering-workflow.md)). The model is signed like every listed file and cross-checked against the manifest; an inconsistent model rejects the package.

Downstream workflow records never go inside a `.tdp`. They live in a separate ledger file (below).

A `.tdp` file is a zip archive containing:

| Path | Purpose |
|---|---|
| `tdp-manifest.json` | What's in the package: metadata, every file with its digest, and the BOM |
| `tdp-manifest.sig.json` | Detached signatures over the manifest bytes |
| everything else | Drawings, models, BOM exports, specs: each must be listed in the manifest |

## Manifest

```json
{
  "schema": "tdp-manifest/0.1",
  "package": {
    "id": "uuid",
    "title": "Sample Bracket Assembly TDP",
    "partNumber": "SMP-1000",
    "revision": "B",
    "created": "2026-11-12T00:00:00.000Z",
    "expires": "2027-11-12T00:00:00.000Z",
    "distribution": "free-text marking"
  },
  "files": [
    {
      "path": "drawings/SMP-1001_A.pdf",
      "sha256": "<64 lowercase hex>",
      "size": 1234,
      "mediaType": "application/pdf",
      "role": "drawing",
      "partNumber": "SMP-1001",
      "revision": "A"
    }
  ],
  "bom": [
    { "partNumber": "SMP-1001", "revision": "A", "name": "Mounting Bracket", "quantity": 1,
      "parent": "SMP-1000", "files": ["drawings/SMP-1001_A.pdf"] }
  ]
}
```

- `role` is one of `drawing`, `model`, `bom`, `spec`, `other`.
- Allowed `mediaType`s come from the viewer's policy: by default `application/pdf`, `model/step`, `application/json`, `text/csv`, `text/plain`.
- Unknown fields anywhere are an error.

## Signatures

```json
{
  "schema": "tdp-signatures/0.1",
  "manifestSha256": "<sha256 of tdp-manifest.json bytes>",
  "signatures": [
    { "keyId": "<32 hex>", "alg": "Ed25519", "role": "author",
      "signedAt": "2026-11-12T00:00:00.000Z", "sig": "<base64>" }
  ]
}
```

See [zero-trust.md](zero-trust.md#what-a-signature-covers) for the exact signed message.

## Trust store

```json
{
  "schema": "tdp-truststore/0.1",
  "keys": [
    { "keyId": "<first 32 hex of sha256(raw public key)>", "name": "Jane Approver",
      "publicKey": "<base64 of 32-byte Ed25519 key>", "roles": ["approver"],
      "notBefore": "…", "notAfter": "…", "revoked": false }
  ]
}
```

`roles` are package-signing roles: `author`, `checker`, `approver`, `release`. They may be empty for a key that only signs workflow records; its workflow roles come from the authority configuration, never from the trust store. `organization` (`{ "name", "cage"? }`) is optional for package signing but required for workflow records; it is vouched for by the trust store's issuer.

## Signed trust store and anchors

A root key signs the exact bytes of a trust store:

```json
{
  "schema": "tdp-signed-truststore/0.1",
  "payload": "<base64 of the trust-store JSON, which includes serial, issuer, issued and expires>",
  "signatures": [{ "keyId": "<root key id>", "alg": "Ed25519", "signedAt": "…", "sig": "<base64>" }]
}
```

The signed message is `tdp-truststore-signature/0.1\n<signedAt>\n<sha256 of payload bytes>`.

Viewers pin roots in an anchors file:

```json
{ "schema": "tdp-anchors/0.1", "roots": [{ "keyId": "…", "name": "Acme Root", "publicKey": "<base64>" }] }
```

## Workflow files

All are strict JSON; unknown fields are rejected. Details in [engineering-workflow.md](engineering-workflow.md).

| Schema | File | Who supplies it |
|---|---|---|
| `tdp-engineering/0.1` | inside a 0.2 package | the baseline's publisher (signed with the package) |
| `tdp-authority/0.1` | `authority.json`, usually wrapped in `tdp-signed-config/0.1` | the operator / organization root |
| `tdp-process/0.1` | process definition; pinned by SHA-256 of its bytes in the authority | the operator |
| `tdp-ledger/0.1` with `tdp-record/0.1` entries | `<unit>.ledger.json`, beside the package | workflow participants, one signed record each |
| `tdp-checkpoint/0.1` | count + head digest of a ledger | whoever must later detect truncation |
| `tdp-recipe/0.1`, `tdp-sync-proposals/0.1`, `tdp-sync-acks/0.1`, `tdp-fixture-source/0.1` | exchange files | publisher, proposer, source adapter |
| `tdp-evidence-bundle/0.1` | exported evidence | `tdp evidence export` |

A record's signature is Ed25519 over `tdp-record-signature/0.1\n<sha256 of the record as canonical JSON>`, where canonical JSON means keys sorted and no whitespace. A signed configuration is signed over `tdp-config-signature/0.1\n<payloadSchema>\n<signedAt>\n<sha256 of payload bytes>`.
