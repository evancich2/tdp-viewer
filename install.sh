#!/usr/bin/env bash
# TDP Viewer installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/evancich2/tdp-viewer/main/install.sh | bash
#
# or, from a checkout:  ./install.sh
#
# What it does, all inside one folder (default ~/tdp-viewer, override with TDP_DIR=...):
#   1. Gets the code (git clone, or a tarball if git isn't installed). Re-running updates it.
#   2. Uses Node 20+ if you have it; otherwise downloads Node 22 LTS from nodejs.org into
#      <folder>/.node after checking its SHA-256. Nothing is installed system-wide, no sudo.
#   3. Installs dependencies, builds the app, and generates the lab demo key files.
#   4. Writes a launcher: <folder>/start-tdp-viewer.command (double-click on macOS, or run it).
#
# Options (environment variables):
#   TDP_DIR=/path        install folder (default: ~/tdp-viewer)
#   TDP_BRANCH=name      branch to install (default: main)
#   TDP_SKIP_LAB=1       skip generating the lab demo (saves ~1 minute)
#   TDP_NODE=download    always use a private Node, even if a suitable one is on PATH
set -euo pipefail

REPO_URL="https://github.com/evancich2/tdp-viewer.git"
TARBALL_URL_BASE="https://codeload.github.com/evancich2/tdp-viewer/tar.gz/refs/heads"
NODE_LINE="latest-v22.x"
DIR="${TDP_DIR:-$HOME/tdp-viewer}"
BRANCH="${TDP_BRANCH:-main}"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux)  OS=linux ;;
  *) die "Unsupported OS $(uname -s). On Windows, use install.ps1 instead." ;;
esac
case "$(uname -m)" in
  x86_64|amd64)  ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) die "Unsupported CPU $(uname -m)." ;;
esac

command -v curl >/dev/null || die "curl is required."
command -v tar  >/dev/null || die "tar is required."

sha256() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

# On macOS, /usr/bin/git is a stub that pops up an installer dialog until the Command Line
# Tools are installed; treat that as "no git" rather than hanging.
have_git() {
  command -v git >/dev/null || return 1
  if [ "$OS" = darwin ] && [ "$(command -v git)" = /usr/bin/git ]; then
    xcode-select -p >/dev/null 2>&1 || return 1
  fi
  return 0
}

# ---------------------------------------------------------------- 1. code
if [ -d "$DIR/.git" ]; then
  have_git || die "$DIR is a git checkout but git isn't usable. Install git, or move that folder aside."
  say "Updating $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  if ! git -C "$DIR" diff --quiet || ! git -C "$DIR" diff --cached --quiet; then
    die "$DIR has local changes; commit or stash them first (git -C \"$DIR\" status)."
  fi
  git -C "$DIR" checkout --quiet "$BRANCH"
  git -C "$DIR" merge --ff-only --quiet "origin/$BRANCH"
elif [ -e "$DIR/package.json" ]; then
  say "Updating $DIR from a fresh download (not a git checkout)"
  tmp="$(mktemp -d)"
  curl -fsSL "$TARBALL_URL_BASE/$BRANCH" | tar -xz -C "$tmp" --strip-components=1
  # Keep the private Node, dependencies and generated keys; replace everything else.
  (cd "$tmp" && tar -cf - .) | (cd "$DIR" && tar -xf -)
  rm -rf "$tmp"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR exists and isn't a TDP Viewer folder. Pick another with TDP_DIR=/some/path."
else
  mkdir -p "$DIR"
  if have_git; then
    say "Cloning TDP Viewer into $DIR"
    git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
  else
    say "git not found; downloading TDP Viewer into $DIR"
    curl -fsSL "$TARBALL_URL_BASE/$BRANCH" | tar -xz -C "$DIR" --strip-components=1
  fi
fi
cd "$DIR"
# Keep the installer's own files out of `git status`.
if [ -d .git ] && ! grep -qs '^/\.node/$' .git/info/exclude; then
  printf '%s\n' '/.node/' '/.build.log' '/.lab.log' '/start-tdp-viewer.command' >>.git/info/exclude
fi

# ---------------------------------------------------------------- 2. Node
node_ok() { "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }

NODE_BIN=""
if [ -x "$DIR/.node/bin/node" ] && node_ok "$DIR/.node/bin/node"; then
  NODE_BIN="$DIR/.node/bin"
elif [ "${TDP_NODE:-}" != download ] && command -v node >/dev/null && node_ok "$(command -v node)" && command -v npm >/dev/null; then
  NODE_BIN="$(dirname "$(command -v node)")"
fi

if [ -z "$NODE_BIN" ]; then
  say "Downloading Node.js ($NODE_LINE, $OS-$ARCH) into $DIR/.node"
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/$NODE_LINE"
  curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  file="$(awk -v s="-$OS-$ARCH.tar.gz" '$2 ~ s"$" {print $2}' "$tmp/SHASUMS256.txt" | head -n1)"
  [ -n "$file" ] || die "No Node build for $OS-$ARCH in $base."
  want="$(awk -v f="$file" '$2 == f {print $1}' "$tmp/SHASUMS256.txt")"
  curl -fSL --progress-bar "$base/$file" -o "$tmp/$file"
  got="$(sha256 "$tmp/$file")"
  [ "$got" = "$want" ] || die "Node download checksum mismatch ($got != $want)."
  rm -rf "$DIR/.node"; mkdir -p "$DIR/.node"
  tar -xzf "$tmp/$file" -C "$DIR/.node" --strip-components=1
  rm -rf "$tmp"
  NODE_BIN="$DIR/.node/bin"
fi
export PATH="$NODE_BIN:$PATH"
say "Using Node $(node -v) from $NODE_BIN"

# ---------------------------------------------------------------- 3. build
say "Installing dependencies (npm ci)"
npm ci --no-audit --no-fund --loglevel=error

say "Building the app"
npm run --silent build >"$DIR/.build.log" 2>&1 || die "Build failed; see $DIR/.build.log"

if [ "${TDP_SKIP_LAB:-}" != 1 ]; then
  say "Generating the lab demo (keys and ledgers in samples/lab/)"
  if npm run --silent lab >"$DIR/.lab.log" 2>&1; then
    # The lab rewrites a few tracked files with fresh timings; put them back so updates stay clean.
    if [ -d .git ]; then
      git checkout --quiet -- samples/lab 2>/dev/null || true
    fi
  else
    warn "Lab demo generation failed (see $DIR/.lab.log). The viewer still works; only the lab signing step needs it."
  fi
fi

# ---------------------------------------------------------------- 4. launcher
launcher="$DIR/start-tdp-viewer.command"
cat >"$launcher" <<EOF
#!/usr/bin/env bash
# Starts TDP Viewer at http://localhost:4173 and opens it in your browser. Ctrl+C to stop.
cd "$DIR"
export PATH="$NODE_BIN:\$PATH"
echo "TDP Viewer: http://localhost:4173   (leave this window open; Ctrl+C to stop)"
exec npx --no-install vite preview --port 4173 --strictPort --open
EOF
chmod +x "$launcher"

cat <<EOF

TDP Viewer is installed in $DIR

  Start it:   $launcher
              (on macOS you can double-click it in Finder)
  Then open:  http://localhost:4173  (it opens automatically)
  Update:     run this installer again
  Printer:    cd "$DIR" && PATH="$NODE_BIN:\$PATH" npm run printer -- discover
              (LAN bridge to a Bambu Lab H2C; see docs/printer-bridge.md)

Sample packages are in $DIR/samples/
EOF
