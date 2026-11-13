# Building and signing a package

The `tdp` CLI turns a folder of drawings and models into a signed `.tdp`. Run it with `npm run tdp -- <command>`.

## 1. Create signing keys (once per person)

```sh
npm run tdp -- keygen --name "Ann Author" --roles author --org "Acme" --out keys/ann
npm run tdp -- keygen --name "Abe Approver" --roles approver --org "Acme" --cage 1ABC2 --out keys/abe
npm run tdp -- keygen --name "Oli Operator" --org "Acme Print Cell" --out keys/oli      # no --roles: signs workflow records only
```

Each command asks for a passphrase (at least 12 characters) and writes two files:

- `keys/ann.key.json`: the private key, encrypted with AES-256-GCM under a key derived from the passphrase with scrypt. It's created readable only by you, and `*.key.json` is gitignored. Keep it to yourself.
- `keys/ann.pub.json`: the public trust-store entry, safe to share.

For scripts, set `TDP_PASSPHRASE` instead of typing it.

**Keys on a hardware token.** Instead of a key file, any signing command accepts `--agent <keyId|comment>` and signs through `SSH_AUTH_SOCK`: for a YubiKey's OpenPGP Ed25519 key, point it at gpg-agent (`export SSH_AUTH_SOCK=$(gpgconf --list-dirs agent-ssh-socket)`). `npm run tdp -- agent list` shows usable keys; `npm run tdp -- agent entry --agent <keyId> --roles approver --org "Acme" --out keys/abe.pub.json` writes the trust-store entry (`--roles root` for an anchors entry).

## 2. Build the trust store (the people the viewer will trust)

```sh
npm run tdp -- trust add trust-store.json keys/ann.pub.json
npm run tdp -- trust add trust-store.json keys/abe.pub.json
npm run tdp -- trust revoke trust-store.json <keyId>     # when a key is lost or someone leaves
```

### Optional: sign the trust store with an organization root

Instead of every viewer vetting each signer key by hand, one organization root key vouches for the trust store:

```sh
npm run tdp -- keygen --name "Acme Root" --roles root --out keys/root       # keep this key offline
npm run tdp -- trust anchor anchors.json keys/root.pub.json                 # give anchors.json to every viewer
npm run tdp -- trust sign trust-store.json --key keys/root.key.json --out trust-store.signed.json
```

Viewers pin `anchors.json` once (**Pin root keys…** in the app, `--anchors` in the CLI) and then accept only trust stores that root signed. Each signed release gets the next serial number and an expiry (`--days`, default 365); a viewer refuses a serial lower than one it has already seen from that root, so an old trust store from before a revocation can't be replayed. After a revocation, sign and distribute the store again.

A root key can't also sign packages: keep it single-purpose and offline.

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
npm run tdp -- verify W-100_A.tdp --trust trust-store.signed.json --anchors anchors.json   # with a signed trust store
```

Signing never rewrites the manifest or files; it only adds to `tdp-manifest.sig.json`, so signers can work one after another on the same file. Before signing, the tool checks every file against the manifest and refuses if anything doesn't match, so a signature always means "I checked this". It also refuses a role the key isn't authorized for.

## 5. Compare revisions

```sh
npm run tdp -- diff W-100_A.tdp W-100_B.tdp --trust trust-store.json
```

Both packages must verify. The report lists package field changes, then files (`+` added, `-` removed, `~` changed or revised, `>` moved), then parts.

## Engineering baselines and workflow records

Add `"engineering": "engineering/model.json"` to `tdp-package.json` to build a `tdp-manifest/0.2` package carrying a `tdp-engineering/0.1` model. After that, workflow steps are signed records in a ledger beside the package, never inside it:

```sh
npm run tdp -- authority sign authority.json --key keys/root.key.json --out authority.signed.json
npm run tdp -- record new part.tdp --item PART@A --out part.ledger.json --trust ... --authority ... --process ...
npm run tdp -- record add part.ledger.json --package part.tdp --key keys/owen.key.json --action approve-requirements \
  --role requirement-owner --outcome approved --reason "..." --data approval.json --evidence-dir evidence/ --trust ... --authority ... --process ...
npm run tdp -- record verify part.ledger.json --package part.tdp --evidence-dir evidence/ --trust ... --authority ... --process ...
```

A step the policy forbids prints `DENIED` with the reason and nothing is signed. A key's package-signing roles give it no workflow role: those come only from the authority configuration's grants. The full walkthrough, with the synthetic laboratory files, is in [laboratory-demo.md](laboratory-demo.md).
