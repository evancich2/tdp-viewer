# Package format (`tdp-manifest/0.1`)

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
