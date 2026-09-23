# Write a zip from a list of files — the packager's zip writer (setup\buildPackage.ts; replaces Python's zipfile,
# 2026-09-24). .NET's ZipArchive streams each file and switches to ZIP64 on its own past 4 GB, which the data parts
# need (the 6-max preflop SQLite alone is 2.7 GB). Entry names are forward-slash paths as given.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\zip.ps1 -Out X.zip -List files.json [-Level Fastest|Optimal]
#
# files.json: [["C:\\abs\\path\\to\\file", "PokerWrapper/rel/path"], ...]
param([Parameter(Mandatory)][string]$Out, [Parameter(Mandatory)][string]$List, [ValidateSet('Fastest', 'Optimal')][string]$Level = 'Optimal')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$items = Get-Content -Raw -Encoding UTF8 -LiteralPath $List | ConvertFrom-Json
$lvl = [System.IO.Compression.CompressionLevel]::$Level
$fs = [System.IO.File]::Open($Out, [System.IO.FileMode]::Create)
try {
  $zip = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create, $false, [System.Text.Encoding]::UTF8)
  try {
    foreach ($it in $items) { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, [string]$it[0], [string]$it[1], $lvl) }
  } finally { $zip.Dispose() }
} finally { $fs.Dispose() }
"zipped $(@($items).Count) files -> $Out"
