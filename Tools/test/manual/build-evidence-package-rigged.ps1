<#
.SYNOPSIS
    Build the rigged-representation evidence package: labelled contact sheet + SHA-256 manifest.

.DESCRIPTION
    Variant of build-evidence-package.ps1 for the rigged-animation-LOD milestone. The foundation
    packager hardcodes its seven stage files; this one takes every PNG in -EvidenceRoot in filename
    order and derives each label from the filename (NN_words_with_underscores). Same output
    contract: one JPEG contact sheet plus a SHA-256 manifest covering the originals and the sheet,
    so the committed evidence is verifiable against the uncommitted originals.

.PARAMETER EvidenceRoot
    Directory containing the stage PNGs (captured via the core capture_view tool).

.PARAMETER OutDir
    Where to write riot-rigged-contact-sheet.jpg and EVIDENCE-SHA256.txt.
#>
param(
    [string] $EvidenceRoot = "F:\.bpmcp-build\RiotEvidence\rigged-final",
    [string] $OutDir       = ""
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not $OutDir) { $OutDir = Join-Path $EvidenceRoot "package" }
New-Item -ItemType Directory -Force $OutDir | Out-Null

$pngs = Get-ChildItem -Path $EvidenceRoot -Filter *.png | Sort-Object Name
if ($pngs.Count -lt 2) { Write-Error "Need at least 2 PNGs in $EvidenceRoot"; exit 1 }

$cols = 2
$rows = [math]::Ceiling($pngs.Count / $cols)
$cellW = 800; $labelH = 34
$first = [System.Drawing.Image]::FromFile($pngs[0].FullName)
$cellH = [int]($cellW * $first.Height / $first.Width) + $labelH
$first.Dispose()

$sheet = New-Object System.Drawing.Bitmap ($cols * $cellW), ($rows * $cellH)
$g = [System.Drawing.Graphics]::FromImage($sheet)
$g.Clear([System.Drawing.Color]::FromArgb(18, 18, 18))
$font = New-Object System.Drawing.Font("Consolas", 13, [System.Drawing.FontStyle]::Bold)
$brush = [System.Drawing.Brushes]::White

for ($i = 0; $i -lt $pngs.Count; $i++) {
    $img = [System.Drawing.Image]::FromFile($pngs[$i].FullName)
    $x = ($i % $cols) * $cellW
    $y = [math]::Floor($i / $cols) * $cellH
    $h = $cellH - $labelH
    $g.DrawImage($img, $x, $y + $labelH, $cellW, $h)
    $label = [System.IO.Path]::GetFileNameWithoutExtension($pngs[$i].Name).Replace("_", " ").ToUpper()
    $g.DrawString($label, $font, $brush, $x + 8, $y + 8)
    $img.Dispose()
}
$g.Dispose()

$sheetPath = Join-Path $OutDir "riot-rigged-contact-sheet.jpg"
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 82)
$sheet.Save($sheetPath, $enc, $params)
$sheet.Dispose()

$manifest = Join-Path $OutDir "EVIDENCE-SHA256.txt"
$lines = @("# Rigged-representation evidence. Originals live in $EvidenceRoot (uncommitted).")
foreach ($f in ($pngs + (Get-Item $sheetPath))) {
    $hash = (Get-FileHash $f.FullName -Algorithm SHA256).Hash.ToLower()
    $lines += "$hash  $($f.Name)"
}
$lines | Out-File -Encoding utf8 $manifest

Write-Output "sheet    : $sheetPath"
Write-Output "manifest : $manifest"
Write-Output "frames   : $($pngs.Count)"
