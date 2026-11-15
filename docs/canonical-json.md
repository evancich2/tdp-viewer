# Hashing rules for metadata and evidence

This is the rule set the tdp-viewer applies, written so other implementations (other prototypes,
a PLM adapter, a reviewer's script) can compute the same digests and refuse the same inputs. It
answers the "metadata hashing is key-order-sensitive" problem: two programs that serialize the same
content differently must still agree on its hash, and must never disagree about what a signed file
says.

## Two kinds of bytes, two rules

| What | Rule | Why |
|---|---|---|
| **Original files**: CAD, drawings, photos, build logs, measurement sheets, sliced jobs, calibration certificates | SHA-256 of the **exact bytes**. Never parsed, normalized or re-encoded. | The original is the evidence. Re-encoding a photo or re-saving a CSV makes a different file. |
| **Package manifests, process definitions, authority configurations, trust stores** | SHA-256 of the **exact bytes** of the file as signed, which must also pass the strict loading rules below. | A signature covers bytes. Pinning these by their bytes means a one-byte change is a different policy. |
| **Structured records**: workflow records, transactions, acknowledgements, evidence bundles, checkpoints | SHA-256 of the **RFC 8785 canonical form** (JCS). | The same content has one digest whatever key order, whitespace or number formatting a file was written with. |

Every reference to another object carries the digest of exactly the version it means (package id
+ manifest SHA-256 + baseline id, record id + record SHA-256, file SHA-256). A name or id alone is
never treated as identifying content.

## Canonical form (RFC 8785)

`src/core/canonical.ts`, tested against the RFC's own examples in `tests/json.test.ts`:

- Object member names are sorted by their **UTF-16 code units**, not by code points. `"😀"`
  sorts before `"דּ"`.
- No whitespace.
- Numbers are written in ECMAScript's shortest round-trip form (`4.50` → `4.5`, `1E30` → `1e+30`,
  `-0` → `0`). NaN and ±Infinity are refused.
- Strings use the minimal JSON escapes (`\"`, `\\`, `\b \f \n \r \t`, `\u00xx` in lowercase hex for
  other control characters). Everything else is written as UTF-8.
- Lone UTF-16 surrogates are refused.

Libraries implementing RFC 8785: Python `rfc8785`, Go `github.com/cyberphone/json-canonicalization`,
Java `org.erdtman:java-json-canonicalization`, JavaScript `canonicalize`. Any of them reproduces the
digests in `samples/lab/`.

## Strict loading (I-JSON, RFC 7493)

`src/core/json.ts`. Every file that comes from outside goes through `parseJson`, which refuses:

- **Duplicate member names**, compared after unescaping (`"a"` and `"a"` are the same name).
  `{"outcome":"accept","outcome":"reject"}` is read as `reject` by JavaScript and Python and as
  `accept` by some other parsers. Two verifiers could then disagree about what a validly signed file
  says, so it is refused instead of read either way.
- **Lone surrogates** in any string or member name.
- **Nesting deeper than 64 levels.**

A file refused here gets a reason (for example `duplicate member name "outcome" at offset 1234`),
never a guess.

## What this doesn't do

- Canonical JSON makes the *same* content hash the same. It doesn't decide whether two different
  representations mean the same thing: `"6.0"` and `6` are different values, and `mm` and `in` are
  different units.
- Large integers beyond 2^53 lose precision in JavaScript, so no field in these formats needs one.
  Counts, sequence numbers and versions are small integers, and digests and ids are strings.
