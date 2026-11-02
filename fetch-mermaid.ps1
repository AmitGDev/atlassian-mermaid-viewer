# Fetches the chunked ESM build of Mermaid from the npm tarball into vendors/.
# vendors/ must hold only unmodified third-party files (AMO review expects this).
$ver = "12.2.0"
$tmp = Join-Path $env:TEMP "mermaid-pkg"
$out = Join-Path $PSScriptRoot "..\vendors"   # adjust if vendors/ is not at the repo root

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $tmp | Out-Null

# --ignore-scripts: only the files are wanted, not install hooks.
npm install "mermaid@$ver" --prefix $tmp --ignore-scripts --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

$dist = Join-Path $tmp "node_modules\mermaid\dist"
$chunks = Join-Path $dist "chunks\mermaid.esm.min"
if (-not (Test-Path $chunks)) { throw "Chunk folder not found at $chunks" }

New-Item -ItemType Directory $out -Force | Out-Null
Remove-Item "$out\mermaid.min.js" -Force -ErrorAction SilentlyContinue
Remove-Item "$out\mermaid-loader.js" -Force -ErrorAction SilentlyContinue  # obsolete: loader was removed
Remove-Item "$out\mermaid.esm.min.mjs" -Force -ErrorAction SilentlyContinue
Remove-Item "$out\chunks" -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory "$out\chunks" -Force | Out-Null

Copy-Item (Join-Path $dist "mermaid.esm.min.mjs") $out
Copy-Item $chunks "$out\chunks\mermaid.esm.min" -Recurse
Get-ChildItem $out -Recurse -Filter *.map | Remove-Item -Force

$files = Get-ChildItem $out -Recurse -File
"{0} files, total {1:N0} bytes, largest {2:N0} bytes" -f $files.Count, ($files | Measure-Object Length -Sum).Sum, ($files | Measure-Object Length -Maximum).Maximum
