<#
.SYNOPSIS
    Capture the Unreal Play-In-Editor window to PNG, for Riot Crowd visual evidence.

.DESCRIPTION
    CLAUDE-NOTE: this helper exists because neither of the plugin's own capture tools can photograph
    a running riot simulation in the configuration this milestone was verified against.

    Observed on UE 5.6.1 with the default PIE mode used by the `start_pie` tool:
      * `viewport_capture` and the `HighResShot` console command both target the EDITOR level
        viewport.
      * Riot agents are Mass entities that exist only in the PIE (game) world.
      * `start_pie` calls RequestPlaySession with WorldType=PlayInEditor and
        DestinationSlateViewport=nullptr, which opens PIE as a separate floating window, so the
        level viewport keeps rendering the editor world.
    The result is a perfectly valid-looking screenshot of an empty field while the runtime report
    correctly says hundreds of agents are alive. That is exactly the kind of plausible-but-wrong
    evidence this project treats as a failure, hence an OS-level grab of the PIE window instead.

    Scope of that claim, deliberately narrow: this is what was measured for the floating-window PIE
    configuration produced by `start_pie` on UE 5.6.1. It is NOT a claim that the built-in tools can
    never capture any PIE configuration. Setting
    LastExecutedPlayModeType=PlayMode_InViewPort in DefaultEditorPerProjectUserSettings.ini was
    tried and did NOT redirect it, because start_pie sets the session params explicitly — but a
    build that passes DestinationSlateViewport, or Simulate-In-Editor, was not tested and may well
    behave differently.

    Safety properties, all deliberate:
      * Resolves the PIE window by process name AND window-title pattern, and refuses to proceed on
        ambiguity.
      * Never writes outside -EvidenceRoot.
      * Never terminates, launches, or modifies any editor or Unreal project.
      * Verifies each output exists and is non-zero before reporting success.
      * Returns a non-zero exit code if the window is unavailable or any output is missing.
      * Has no hard-coded project paths.

.PARAMETER EvidenceRoot
    Directory to write PNGs into. Created if absent. Nothing is ever written outside it.

.PARAMETER Name
    Base filename (no extension) for this capture.

.PARAMETER WindowTitlePattern
    Wildcard the PIE window title must match. The default matches Unreal's standard PIE title, e.g.
    "MyProject Preview [NetMode: Standalone 0]  (64-bit/PC D3D SM5)".

.EXAMPLE
    .\capture-riot-pie.ps1 -EvidenceRoot F:\evidence -Name breach

.EXAMPLE
    # Typical use: drive the sim over HTTP, capturing between steps.
    .\capture-riot-pie.ps1 -EvidenceRoot F:\evidence -Name approaching
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $EvidenceRoot,
    [Parameter(Mandatory = $true)] [string] $Name,
    [string] $WindowTitlePattern = "*Preview*NetMode*",
    [string] $ProcessName = "UnrealEditor"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class RiotPieCapture {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
}
"@

# CLAUDE-NOTE: writes straight to stderr rather than using Write-Error. With
# $ErrorActionPreference = "Stop", Write-Error raises a terminating error, so the `exit 1` below
# would never execute and the documented exit code would be an accident of the host rather than
# something this script guarantees. Callers gate on that code, so it has to be deliberate.
function Fail([string] $Message) {
    [Console]::Error.WriteLine("capture-riot-pie: $Message")
    exit 1
}

# ---- validate the output root, and refuse to write anywhere else -------------------------------
if ([string]::IsNullOrWhiteSpace($EvidenceRoot)) { Fail "EvidenceRoot must not be empty." }
if ($Name -match '[\\/:*?"<>|]') { Fail "Name '$Name' contains path or wildcard characters." }

New-Item -ItemType Directory -Force -Path $EvidenceRoot | Out-Null
$rootFull = (Resolve-Path -LiteralPath $EvidenceRoot).ProviderPath
$outPath  = [System.IO.Path]::GetFullPath((Join-Path $rootFull "$Name.png"))

# Guard against traversal: the resolved output must still sit under the evidence root.
if (-not $outPath.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    Fail "Refusing to write outside the evidence root ('$outPath' is not under '$rootFull')."
}

# ---- resolve the PIE window, refusing anything ambiguous ---------------------------------------
$candidates = @(
    Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like $WindowTitlePattern }
)

if ($candidates.Count -eq 0) {
    Fail ("No '$ProcessName' window matching '$WindowTitlePattern' is open. " +
          "Start PIE first (start_pie); this helper never launches or modifies an editor.")
}
if ($candidates.Count -gt 1) {
    $titles = ($candidates | ForEach-Object { "'" + $_.MainWindowTitle + "' (pid " + $_.Id + ")" }) -join "; "
    Fail "Ambiguous PIE window - $($candidates.Count) matched: $titles. Close the extras and retry."
}

$proc   = $candidates[0]
$handle = $proc.MainWindowHandle
if (-not [RiotPieCapture]::IsWindowVisible($handle)) { Fail "The PIE window is not visible." }

# ---- bring it forward and grab the client area -------------------------------------------------
[void][RiotPieCapture]::ShowWindow($handle, 9)   # SW_RESTORE
[void][RiotPieCapture]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 900                    # allow the compositor to present it on top

$rect = New-Object RiotPieCapture+RECT
if (-not [RiotPieCapture]::GetClientRect($handle, [ref]$rect)) { Fail "GetClientRect failed." }

$origin = New-Object RiotPieCapture+POINT
if (-not [RiotPieCapture]::ClientToScreen($handle, [ref]$origin)) { Fail "ClientToScreen failed." }

$width  = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) { Fail "PIE window client area is $width x $height." }

# CLAUDE-NOTE: CopyFromScreen, not PrintWindow. The PIE viewport is a D3D swap-chain surface that
# never goes through GDI, so PrintWindow yields an empty or black rectangle.
$bitmap   = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0,
        (New-Object System.Drawing.Size($width, $height)))
    $bitmap.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

# ---- verify the artefact, rather than trusting that Save() returned --------------------------
if (-not (Test-Path -LiteralPath $outPath)) { Fail "Expected output '$outPath' was not created." }
$size = (Get-Item -LiteralPath $outPath).Length
if ($size -le 0) { Fail "Output '$outPath' is zero bytes." }

$sha = (Get-FileHash -LiteralPath $outPath -Algorithm SHA256).Hash

[PSCustomObject]@{
    Path        = $outPath
    Width       = $width
    Height      = $height
    Bytes       = $size
    SHA256      = $sha
    WindowTitle = $proc.MainWindowTitle
    Pid         = $proc.Id
} | Format-List

exit 0
