# TDP Viewer installer for Windows (PowerShell 5.1 or newer).
#
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/evancich2/tdp-viewer/main/install.ps1 | iex"
#
# or, from a checkout:  powershell -ExecutionPolicy Bypass -File install.ps1
#
# Same steps as install.sh, all inside one folder (default %USERPROFILE%\tdp-viewer, override with
# $env:TDP_DIR): get the code (git clone, or a zip if git isn't installed; re-running updates it),
# use Node 20+ if present or download Node 22 LTS into <folder>\.node after checking its SHA-256,
# install dependencies, build, generate the lab demo keys, and write start-tdp-viewer.cmd.
# No admin rights needed. Options: $env:TDP_DIR, $env:TDP_BRANCH, $env:TDP_SKIP_LAB=1, $env:TDP_NODE=download
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$RepoUrl  = 'https://github.com/evancich2/tdp-viewer.git'
$ZipBase  = 'https://codeload.github.com/evancich2/tdp-viewer/zip/refs/heads'
$NodeLine = 'latest-v22.x'
$Dir      = if ($env:TDP_DIR) { $env:TDP_DIR } else { Join-Path $env:USERPROFILE 'tdp-viewer' }
$Branch   = if ($env:TDP_BRANCH) { $env:TDP_BRANCH } else { 'main' }

function Say($m)  { Write-Host "==> $m" -ForegroundColor Cyan }
function Warn($m) { Write-Host "warning: $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "error: $m" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$argv) { & $exe @argv; if ($LASTEXITCODE -ne 0) { Die "$exe $($argv -join ' ') failed" } }

$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
$haveGit = [bool](Get-Command git -ErrorAction SilentlyContinue)

function Get-Zip {
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  Invoke-WebRequest "$ZipBase/$Branch" -OutFile "$tmp\src.zip" -UseBasicParsing
  Expand-Archive "$tmp\src.zip" "$tmp\x"
  $inner = Get-ChildItem "$tmp\x" | Select-Object -First 1
  New-Item -ItemType Directory -Force $Dir | Out-Null
  Copy-Item "$($inner.FullName)\*" $Dir -Recurse -Force
  Remove-Item $tmp -Recurse -Force
}

# ---------------------------------------------------------------- 1. code
if (Test-Path "$Dir\.git") {
  if (-not $haveGit) { Die "$Dir is a git checkout but git isn't installed." }
  Say "Updating $Dir"
  Run git @('-C', $Dir, 'fetch', '--quiet', 'origin', $Branch)
  git -C $Dir diff --quiet; $d1 = $LASTEXITCODE
  git -C $Dir diff --cached --quiet; $d2 = $LASTEXITCODE
  if ($d1 -ne 0 -or $d2 -ne 0) { Die "$Dir has local changes; commit or stash them first." }
  Run git @('-C', $Dir, 'checkout', '--quiet', $Branch)
  Run git @('-C', $Dir, 'merge', '--ff-only', '--quiet', "origin/$Branch")
} elseif (Test-Path "$Dir\package.json") {
  Say "Updating $Dir from a fresh download (not a git checkout)"
  Get-Zip
} elseif ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
  Die "$Dir exists and isn't a TDP Viewer folder. Pick another with `$env:TDP_DIR."
} elseif ($haveGit) {
  Say "Cloning TDP Viewer into $Dir"
  Run git @('clone', '--quiet', '--branch', $Branch, $RepoUrl, $Dir)
} else {
  Say "git not found; downloading TDP Viewer into $Dir"
  Get-Zip
}
Set-Location $Dir
if ((Test-Path '.git') -and -not (Select-String -Quiet -SimpleMatch '/.node/' '.git\info\exclude' -ErrorAction SilentlyContinue)) {
  Add-Content '.git\info\exclude' "/.node/`n/.build.log`n/.lab.log`n/start-tdp-viewer.cmd"
}

# ---------------------------------------------------------------- 2. Node
function Test-Node($exe) {
  try { & $exe -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>$null; return $LASTEXITCODE -eq 0 } catch { return $false }
}
$NodeDir = $null
if ((Test-Path "$Dir\.node\node.exe") -and (Test-Node "$Dir\.node\node.exe")) {
  $NodeDir = "$Dir\.node"
} elseif ($env:TDP_NODE -ne 'download') {
  $n = Get-Command node -ErrorAction SilentlyContinue
  if ($n -and (Get-Command npm -ErrorAction SilentlyContinue) -and (Test-Node $n.Source)) { $NodeDir = Split-Path $n.Source }
}
if (-not $NodeDir) {
  Say "Downloading Node.js ($NodeLine, win-$arch) into $Dir\.node"
  $base = "https://nodejs.org/dist/$NodeLine"
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid())
  New-Item -ItemType Directory $tmp | Out-Null
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content -split "`n"
  $line = $sums | Where-Object { $_ -match "\s(node-v[\d.]+-win-$arch\.zip)$" } | Select-Object -First 1
  if (-not $line) { Die "No Node build for win-$arch in $base." }
  $want, $file = ($line.Trim() -split '\s+')
  Invoke-WebRequest "$base/$file" -OutFile "$tmp\$file" -UseBasicParsing
  $got = (Get-FileHash "$tmp\$file" -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want) { Die "Node download checksum mismatch ($got != $want)." }
  Expand-Archive "$tmp\$file" "$tmp\x"
  if (Test-Path "$Dir\.node") { Remove-Item "$Dir\.node" -Recurse -Force }
  Move-Item (Get-ChildItem "$tmp\x" | Select-Object -First 1).FullName "$Dir\.node"
  Remove-Item $tmp -Recurse -Force
  $NodeDir = "$Dir\.node"
}
$env:Path = "$NodeDir;$env:Path"
Say "Using Node $(node -v) from $NodeDir"

# ---------------------------------------------------------------- 3. build
Say 'Installing dependencies (npm ci)'
Run npm.cmd @('ci', '--no-audit', '--no-fund', '--loglevel=error')

Say 'Building the app'
& npm.cmd run --silent build *> "$Dir\.build.log"
if ($LASTEXITCODE -ne 0) { Die "Build failed; see $Dir\.build.log" }

if ($env:TDP_SKIP_LAB -ne '1') {
  Say 'Generating the lab demo (keys and ledgers in samples\lab\)'
  & npm.cmd run --silent lab *> "$Dir\.lab.log"
  if ($LASTEXITCODE -eq 0) {
    if (Test-Path '.git') { git checkout --quiet -- samples/lab 2>$null }
  } else {
    Warn "Lab demo generation failed (see $Dir\.lab.log). The viewer still works; only the lab signing step needs it."
  }
}

# ---------------------------------------------------------------- 4. launcher
$launcher = "$Dir\start-tdp-viewer.cmd"
@"
@echo off
rem Starts TDP Viewer at http://localhost:4173 and opens it in your browser. Close this window to stop.
cd /d "$Dir"
set "PATH=$NodeDir;%PATH%"
echo TDP Viewer: http://localhost:4173   (leave this window open; close it to stop)
npx --no-install vite preview --port 4173 --strictPort --open
"@ | Set-Content -Encoding ASCII $launcher

Write-Host ""
Write-Host "TDP Viewer is installed in $Dir"
Write-Host ""
Write-Host "  Start it:   double-click $launcher"
Write-Host "  Then open:  http://localhost:4173  (it opens automatically)"
Write-Host "  Update:     run this installer again"
Write-Host ""
Write-Host "Sample packages are in $Dir\samples\"
