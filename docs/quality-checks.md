# Quality checks

| Check | Command | Gate |
|---|---|---|
| Type check | `npm run typecheck` | CI |
| Lint | `npm run lint` | CI |
| Unit tests | `npm test` | CI |
| Shared digest vectors | `npm run vectors -- --check` | CI; published fixture must match code |
| Laboratory demonstrations | `npm run lab` | CI (and byte-for-byte reproducible) |
| End-to-end, real Chrome, production CSP | `npm run e2e` | CI |
| Known vulnerabilities in dependencies | `npm audit` | CI (`--audit-level=high`) |
| All of type check, lint and tests | `npm run check` | local |

## Build size and byte preservation

The November 15 production build measured the on-demand `ModelViewer` chunk at about 561 kB
minified (140 kB gzip). `FilePreview.tsx` loads it with `React.lazy`; PDF rendering is also behind
a lazy boundary. The warning threshold is 600 kB so further growth remains visible. The separate
OCCT worker includes roughly 10.2 MB of WASM/glue, and the PDF worker is roughly 1.26 MB.
Lazy rendering does not shrink these files or the service worker's full offline precache download.
Production Chrome tests cover both model rendering and offline loading under the CSP.

Git checkout must preserve signed fixture bytes: `.gitattributes` fixes text files to LF on Windows
as well as Linux. Reproducibility allows timings in `demo-results.*` and the SN-0001 bundle to vary;
replacement-article bundles are included in the strict comparison rather than broadly exempted.
Windows skips Unix SSH-agent and POSIX CLI tests; Linux CI must run them before merge.

## Lint

[oxlint](https://oxc.rs) with ESLint-compatible rules from the eslint, typescript, react,
react-hooks, import, promise, vitest, jsx-a11y, node and unicorn plugins. The `correctness` and
`suspicious` categories are errors, and warnings fail the run. typescript-eslint isn't used because
it doesn't support TypeScript 7, the native compiler this project builds with. Every rule turned off
in [`.oxlintrc.json`](../.oxlintrc.json) is listed there with its reason.

## Static analysis

[Semgrep](https://semgrep.dev) with the `p/typescript`, `p/javascript`, `p/react`, `p/nodejs`,
`p/secrets`, `p/security-audit`, `p/owasp-top-ten` and `p/github-actions` rule packs, run locally
with metrics off:

```sh
semgrep scan --metrics=off --no-git-ignore \
  --config p/typescript --config p/javascript --config p/react --config p/nodejs \
  --config p/secrets --config p/security-audit --config p/owasp-top-ten --config p/github-actions .
```

[`.semgrepignore`](../.semgrepignore) sets the scope (tests are scanned). The suppressions in the
source each carry a reason: the printer bridge replaces TLS chain validation with an exact
certificate pin (the printer's certificate is self-signed), and tests talk to local servers. The
only remaining finding on a working copy is the developer's own gitignored SSH key, which is never
committed.

## Known vulnerabilities

`npm audit`, cross-checked with [osv-scanner](https://github.com/google/osv-scanner)
(`osv-scanner scan source --lockfile package-lock.json`) against the OSV database, which includes
the GitHub advisories. Check the Node.js runtime separately: <https://nodejs.org/en/blog/vulnerability>.

## Results, 2026-11-15

- npm audit: 0 vulnerabilities (152 packages). osv-scanner 2.7.1: no issues. Node 22.23.5 is the
  newest 22.x, and no newer security release exists.
- oxlint 1.90.0: 0 problems after the fixes below.
- Semgrep 1.182.1, 167 rules, 121 files: 0 findings in the code.

Fixed as a result:

- Key files: AES-GCM tags are required to be a full 16 bytes (Node otherwise accepts a truncated
  tag); scrypt parameters are bounded in the file schema (a crafted file could make the CLI allocate
  without limit); the decrypted private key must match the file's public key.
- Strict JSON loading for every file from outside (see [canonical-json.md](canonical-json.md)).
- Unhandled promise rejections: drawing page load, custody check, service worker registration.
- An error rethrown without its cause (printer bridge).
- CI actions pinned to full commit SHAs; lint and type check added to CI.
