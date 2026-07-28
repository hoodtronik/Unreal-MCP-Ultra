<#
.SYNOPSIS
    Build a durable Riot Crowd evidence package: one compressed contact sheet plus a SHA-256
    manifest.

.DESCRIPTION
    CLAUDE-NOTE: the seven full-resolution PNGs are ~9 MB total, which this repository does not
    commit (it has no precedent for committing test evidence). But a machine-local path is not
    evidence retention — the review record has to survive this machine. The compromise is a single
    compressed contact sheet, small enough to version, plus a SHA-256 manifest so the originals can
    be authenticated later if they are produced.

    Reads only; never modifies the source images.

.PARAMETER EvidenceRoot
    Directory containing the seven stage PNGs.

.PARAMETER OutDir
    Where to write the contact sheet and manifest.
#>
[CmdletBinding()]
param(
    [string] $EvidenceRoot = "F:\.bpmcp-build\RiotEvidence",
    [string] $OutDir       = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# CLAUDE-NOTE: resolved here, not as a param default. $PSScriptRoot is not populated during
# parameter binding when the script is invoked with -File, so the default silently evaluated to an
# empty string and Join-Path threw.
if ([string]::IsNullOrWhiteSpace($OutDir)) {
    $OutDir = Join-Path $PSScriptRoot "..\..\..\docs\riot-crowd\evidence"
}

function Fail([string] $m) { [Console]::Error.WriteLine("build-evidence-package: $m"); exit 1 }

# Stage order is the narrative order of the demonstration, not alphabetical by accident.
$stages = @(
    @{ File = "A_spawned.png";       Label = "1. SPAWNED - 210 rioters + 34 defenders, t=0" }
    @{ File = "B_approaching.png";   Label = "2. APPROACHING - three flow origins converge, t=10.0s" }
    @{ File = "C_pressing.png";      Label = "3. PRESSING - contact, pressure climbing, t=17.1s" }
    @{ File = "D_breach.png";        Label = "4. BREACH - centre gives way, flanks hold, t=22.1s" }
    @{ File = "E_through_panic.png"; Label = "5. THROUGH / PANIC - 126 past, 70 routed, t=27.1s" }
    @{ File = "F_retreating.png";    Label = "6. RETREATING - rout scatters, line restored, t=36.2s" }
    @{ File = "G_after_reset.png";   Label = "7. AFTER RESET - all runtime objects removed" }
)

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).ProviderPath

foreach ($s in $stages) {
    $p = Join-Path $EvidenceRoot $s.File
    if (-not (Test-Path -LiteralPath $p)) { Fail "missing source image: $p" }
    if ((Get-Item -LiteralPath $p).Length -le 0) { Fail "zero-byte source image: $p" }
}

# ---- compose: 2 columns x 4 rows, last cell left empty --------------------------------------
$cols = 2; $rows = 4
$cellW = 620; $cellH = 366        # ~1286x760 scaled to roughly half
$labelH = 26; $pad = 10
$sheetW = $pad + $cols * ($cellW + $pad)
$sheetH = $pad + $rows * ($cellH + $labelH + $pad)

$sheet = New-Object System.Drawing.Bitmap($sheetW, $sheetH)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.Clear([System.Drawing.Color]::FromArgb(24, 24, 28))

$font = New-Object System.Drawing.Font("Consolas", 11, [System.Drawing.FontStyle]::Bold)
$brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 235, 240))

for ($i = 0; $i -lt $stages.Count; $i++) {
    $col = $i % $cols
    $row = [math]::Floor($i / $cols)
    $x = $pad + $col * ($cellW + $pad)
    $y = $pad + $row * ($cellH + $labelH + $pad)

    $src = [System.Drawing.Image]::FromFile((Join-Path $EvidenceRoot $stages[$i].File))
    try {
        $g.DrawString($stages[$i].Label, $font, $brush, $x, $y)
        $g.DrawImage($src, $x, ($y + $labelH), $cellW, $cellH)
    } finally { $src.Dispose() }
}

$g.Dispose()

# JPEG at quality 82: the sheet is a review aid, not a pixel reference. The SHA-256 manifest below
# is what authenticates the lossless originals.
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
         Where-Object { $_.MimeType -eq "image/jpeg" }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
    [System.Drawing.Imaging.Encoder]::Quality, 82)

$sheetPath = Join-Path $OutDir "riot-stages-contact-sheet.jpg"
$sheet.Save($sheetPath, $codec, $params)
$sheet.Dispose()

if (-not (Test-Path -LiteralPath $sheetPath)) { Fail "contact sheet was not written" }
if ((Get-Item -LiteralPath $sheetPath).Length -le 0) { Fail "contact sheet is zero bytes" }

# ---- SHA-256 manifest ---------------------------------------------------------------------
$helper = Join-Path $PSScriptRoot "capture-riot-pie.ps1"
$rows = @()

foreach ($s in $stages) {
    $p = Join-Path $EvidenceRoot $s.File
    $img = [System.Drawing.Image]::FromFile($p)
    $rows += [PSCustomObject]@{
        File   = $s.File
        Kind   = "original stage capture (PNG, not committed)"
        Bytes  = (Get-Item -LiteralPath $p).Length
        Width  = $img.Width
        Height = $img.Height
        SHA256 = (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash
    }
    $img.Dispose()
}

$csImg = [System.Drawing.Image]::FromFile($sheetPath)
$rows += [PSCustomObject]@{
    File   = "riot-stages-contact-sheet.jpg"
    Kind   = "compressed contact sheet (committed)"
    Bytes  = (Get-Item -LiteralPath $sheetPath).Length
    Width  = $csImg.Width
    Height = $csImg.Height
    SHA256 = (Get-FileHash -LiteralPath $sheetPath -Algorithm SHA256).Hash
}
$csImg.Dispose()

if (Test-Path -LiteralPath $helper) {
    $rows += [PSCustomObject]@{
        File   = "capture-riot-pie.ps1"
        Kind   = "capture helper used to produce the stage captures (committed)"
        Bytes  = (Get-Item -LiteralPath $helper).Length
        Width  = $null
        Height = $null
        SHA256 = (Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash
    }
} else { Fail "capture helper not found at $helper" }

$manifestPath = Join-Path $OutDir "EVIDENCE-SHA256.txt"
$lines = @()
$lines += "Riot Crowd foundation - visual evidence manifest"
$lines += "================================================="
$lines += ""
$lines += "Originals live at: $EvidenceRoot"
$lines += "They are NOT committed (this repository has no precedent for committing test evidence)."
$lines += "The contact sheet below IS committed, and these hashes authenticate the originals if they"
$lines += "are ever produced for audit."
$lines += ""
foreach ($r in $rows) {
    $dim = if ($null -ne $r.Width) { "$($r.Width)x$($r.Height)" } else { "-" }
    $lines += ("{0}  {1}" -f $r.SHA256, $r.File)
    $lines += ("{0}  bytes={1}  dimensions={2}" -f (" " * 64), $r.Bytes, $dim)
    $lines += ("{0}  {1}" -f (" " * 64), $r.Kind)
    $lines += ""
}
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($manifestPath, ($lines -join "`r`n"), $utf8NoBom)

if (-not (Test-Path -LiteralPath $manifestPath)) { Fail "manifest was not written" }

Write-Output "contact sheet : $sheetPath"
Write-Output ("                {0} bytes, {1}x{2}" -f (Get-Item $sheetPath).Length, $sheetW, $sheetH)
Write-Output "manifest      : $manifestPath"
Write-Output ("                {0} bytes, {1} entries" -f (Get-Item $manifestPath).Length, $rows.Count)
exit 0
