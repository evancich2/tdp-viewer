# Building and signing a package

The `tdp` CLI turns a folder of drawings and models into a signed `.tdp`. Run it with `npm run tdp -- <command>`.

## 1. Create signing keys (once per person)

```sh
npm run tdp -- keygen --name "Ann Author" --roles author --out keys/ann
npm run tdp -- keygen --name "Abe Approver" --roles approver --out keys/abe
```

Each command asks for a passphrase (at least 12 characters) and writes two files:

- `keys/ann.key.json`: the private key, encrypted with AES-256-GCM under a key derived from the passphrase with scrypt. It's created readable only by you, and `*.key.json` is gitignored. Keep it to yourself.
- `keys/ann.pub.json`: the public trust-store entry, safe to share.

For scripts, set `TDP_PASSPHRASE` instead of typing it.

## 2. Build the trust store (the people the viewer will trust)

```sh
npm run tdp -- trust add trust-store.json keys/ann.pub.json
npm run tdp -- trust add trust-store.json keys/abe.pub.json
npm run tdp -- trust revoke trust-store.json <keyId>     # when a key is lost or someone leaves
```

## 3. Describe the package

Put a `tdp-package.json` in the folder:

```json
{
  "package": { "title": "Washer TDP", "partNumber": "W-100", "revision": "A", "expires": "2027-12-31T00:00:00Z" },
  "files": {
    "models/W-100_A.stp": { "partNumber": "W-100", "revision": "A" }
  },
  "bom": [
    { "partNumber": "W-100", "revision": "A", "name": "Washer", "quantity": 1,
      "files": ["drawings/W-100_A.pdf", "models/W-100_A.stp"] }
  ]
}
```

Every other file in the folder goes into the package. Media type and role come from the extension (`.pdf` drawing, `.stp`/`.step` model, `.csv` BOM, `.txt` spec, `.json` other); override them under `files`.

## 4. Pack, then sign once per role

```sh
npm run tdp -- pack parts/W-100 --out W-100_A.tdp
npm run tdp -- sign W-100_A.tdp --key keys/ann.key.json --role author
npm run tdp -- sign W-100_A.tdp --key keys/abe.key.json --role approver
npm run tdp -- verify W-100_A.tdp --trust trust-store.json
```

Signing never rewrites the manifest or files; it only adds to `tdp-manifest.sig.json`, so signers can work one after another on the same file. Before signing, the tool checks every file against the manifest and refuses if anything doesn't match, so a signature always means "I checked this". It also refuses a role the key isn't authorized for.

## 5. Compare revisions

```sh
npm run tdp -- diff W-100_A.tdp W-100_B.tdp --trust trust-store.json
```

Both packages must verify. The report lists package field changes, then files (`+` added, `-` removed, `~` changed or revised, `>` moved), then parts.
