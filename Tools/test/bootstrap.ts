/**
 * bootstrap.ts — Generate a temp UE5 project and manage the commandlet lifecycle.
 *
 * The temp project contains:
 *   TestProject.uproject  — minimal JSON pointing at BlueprintMCP plugin
 *   Plugins/BlueprintMCP/ — directory junction to the real plugin source
 *   Content/              — empty; tests create Blueprints into /Game/Test/
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawn, type ChildProcess } from "node:child_process";

/** Port used by the test commandlet (distinct from editor's 9847). */
export const TEST_PORT = 19847;
export const TEST_BASE_URL = `http://localhost:${TEST_PORT}`;

/** Absolute path to the plugin root (two levels up from test/). */
const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..");

let tempDir: string | null = null;
let cmdProcess: ChildProcess | null = null;

// ---------------------------------------------------------------------------
// Temp project generation
// ---------------------------------------------------------------------------

/**
 * Where to generate the throwaway test project.
 *
 * CLAUDE-NOTE: deliberately NOT os.tmpdir(). UE expresses project paths relative to
 * Engine/Binaries/Win64, so when the temp dir is on the SAME drive as the engine it produces a
 * long "../../../../../.." chain. FilenameToLongPackageName rejects that ("the path contains
 * illegal characters '.'") and the commandlet dies with a fatal error during startup — before the
 * HTTP server binds, so the only visible symptom is "Commandlet failed to become healthy within
 * 4 minutes". Putting the project on the plugin's drive (normally not the engine drive) keeps UE
 * on absolute paths. Override with UE_TEST_TMP if that drive is unsuitable.
 */
function testTempRoot(): string {
  if (process.env.UE_TEST_TMP) return process.env.UE_TEST_TMP;
  // Compare drive LETTERS, not root strings — path.parse can return "F:/" or "F:\" depending on
  // how the path was built, so a raw string compare can call the same drive different.
  const driveLetter = (p: string): string => (path.parse(p).root.match(/[a-zA-Z]/)?.[0] ?? "").toLowerCase();
  const pluginDrive = driveLetter(PLUGIN_ROOT);
  const engineDrive = driveLetter(findEditorCmd() ?? "C:\\");
  if (pluginDrive && pluginDrive !== engineDrive) {
    return path.join(path.parse(PLUGIN_ROOT).root, ".bpmcp-test");
  }
  // Same drive (or undetectable): fall back to the OS temp dir and hope the path is shallow.
  return os.tmpdir();
}

export function generateTempProject(): string {
  const dir = path.join(testTempRoot(), `BlueprintMCP_Test_${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });

  // Minimal .uproject — engine version must match the compiled plugin DLL
  const engineVersion = detectEngineVersion();
  const uproject = {
    FileVersion: 3,
    EngineAssociation: engineVersion,
    Plugins: [{ Name: "BlueprintMCP", Enabled: true }],
  };
  fs.writeFileSync(
    path.join(dir, "TestProject.uproject"),
    JSON.stringify(uproject, null, "\t") + "\n",
  );

  // Content directory (blueprints land here)
  fs.mkdirSync(path.join(dir, "Content"), { recursive: true });

  // Plugins/BlueprintMCP → junction to real plugin
  const pluginsDir = path.join(dir, "Plugins");
  fs.mkdirSync(pluginsDir, { recursive: true });

  const junctionTarget = path.join(pluginsDir, "BlueprintMCP");
  // cmd /c mklink /J works without admin on Windows
  execSync(`cmd /c mklink /J "${junctionTarget}" "${PLUGIN_ROOT}"`, {
    stdio: "ignore",
  });

  tempDir = dir;
  console.log(`[bootstrap] Temp project created at ${dir}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Commandlet lifecycle
// ---------------------------------------------------------------------------

/**
 * Engine version this plugin targets. Must match the version the C++ was compiled against.
 *
 * CLAUDE-NOTE: the compiled plugin DLL carries a BuildId tied to ONE engine version. Launching a
 * different editor against it fails with "Plugin 'BlueprintMCP' failed to load because module
 * 'BlueprintMCP' could not be found" — which reads like a missing binary, not a version mismatch,
 * and costs a long time to diagnose. These helpers used to prefer the NEWEST installed engine,
 * so on a machine with 5.6 through 5.8 installed every test run silently launched 5.8 against a
 * 5.6 DLL and could never pass. Prefer the target version; only fall back to newest if it's absent,
 * and say so loudly when that happens.
 */
// CLAUDE-NOTE (dual-engine, 2026-09-22): one source tree now builds for 5.6 and 5.8, so the engine the
// suite boots must follow the engine the DLL in Binaries/Win64 was built against. Default stays 5.6; set
// BPMCP_ENGINE_VERSION=5.8 after a 5.8 build. A mismatch reproduces the BuildId failure described above.
const TARGET_ENGINE_VERSION = process.env.BPMCP_ENGINE_VERSION ?? "5.6";

const ENGINE_BASES = [
  "C:\\Program Files\\Epic Games",
  "C:\\Program Files (x86)\\Epic Games",
];

/** Installed engine version strings (e.g. "5.6"), newest first. */
function installedEngineVersions(): string[] {
  const found = new Set<string>();
  for (const base of ENGINE_BASES) {
    try {
      for (const d of fs.readdirSync(base)) {
        if (d.startsWith("UE_")) found.add(d.replace("UE_", ""));
      }
    } catch { /* directory not found */ }
  }
  return [...found].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

/** Engine version to generate the temp project against — the target if installed. */
function detectEngineVersion(): string {
  const installed = installedEngineVersions();
  if (installed.includes(TARGET_ENGINE_VERSION)) return TARGET_ENGINE_VERSION;
  if (installed.length > 0) {
    console.warn(
      `[bootstrap] UE ${TARGET_ENGINE_VERSION} not installed; falling back to ${installed[0]}. ` +
      `The plugin DLL is built for ${TARGET_ENGINE_VERSION}, so the module will likely fail to load.`,
    );
    return installed[0];
  }
  return TARGET_ENGINE_VERSION;
}

function findEditorCmd(): string | null {
  if (process.env.UE_EDITOR_CMD && fs.existsSync(process.env.UE_EDITOR_CMD)) {
    return process.env.UE_EDITOR_CMD;
  }
  // Try the target version first, then any other installed engine as a fallback.
  const ordered = [
    TARGET_ENGINE_VERSION,
    ...installedEngineVersions().filter((v) => v !== TARGET_ENGINE_VERSION),
  ];
  for (const version of ordered) {
    for (const base of ENGINE_BASES) {
      const cmd = path.join(base, `UE_${version}`, "Engine", "Binaries", "Win64", "UnrealEditor-Cmd.exe");
      if (fs.existsSync(cmd)) return cmd;
    }
  }
  return null;
}

async function waitForHealth(timeoutMs: number = 240_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(`${TEST_BASE_URL}/api/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return true;
    } catch {
      // not ready yet
    }
    if (!cmdProcess) return false; // process died
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

export async function spawnCommandlet(projectDir: string): Promise<void> {
  const editorCmd = findEditorCmd();
  if (!editorCmd) {
    throw new Error(
      "UnrealEditor-Cmd.exe not found. Set UE_EDITOR_CMD env var.",
    );
  }

  const uproject = path.join(projectDir, "TestProject.uproject");
  const logPath = path.join(projectDir, "Saved", "Logs", "Test_server.log");

  console.log(`[bootstrap] Spawning commandlet on port ${TEST_PORT}...`);
  cmdProcess = spawn(
    editorCmd,
    [
      uproject,
      "-run=BlueprintMCP",
      `-port=${TEST_PORT}`,
      "-unattended",
      "-nopause",
      "-nullrhi",
      `-LOG=${logPath}`,
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  cmdProcess.stdout?.on("data", (d: Buffer) => {
    process.stderr.write(`[UE5:out] ${d.toString().trimEnd()}\n`);
  });
  cmdProcess.stderr?.on("data", (d: Buffer) => {
    process.stderr.write(`[UE5:err] ${d.toString().trimEnd()}\n`);
  });
  cmdProcess.on("exit", (code) => {
    console.log(`[bootstrap] Commandlet exited with code ${code}`);
    cmdProcess = null;
  });

  console.log("[bootstrap] Waiting for health (up to 4 min)...");
  const ok = await waitForHealth(240_000);
  if (!ok) {
    // Dump the log file if it exists
    try {
      const log = fs.readFileSync(logPath, "utf-8");
      console.error("[bootstrap] === Commandlet log (last 80 lines) ===");
      console.error(log.split("\n").slice(-80).join("\n"));
    } catch { /* no log */ }

    if (cmdProcess) {
      cmdProcess.kill();
      cmdProcess = null;
    }
    throw new Error("Commandlet failed to become healthy within 4 minutes.");
  }
  console.log("[bootstrap] Commandlet is healthy.");
}

// ---------------------------------------------------------------------------
// Shutdown & cleanup
// ---------------------------------------------------------------------------

export async function shutdownCommandlet(): Promise<void> {
  if (!cmdProcess) return;

  // Graceful HTTP shutdown
  try {
    await fetch(`${TEST_BASE_URL}/api/shutdown`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* may already be gone */ }

  // Wait for exit
  const proc = cmdProcess;
  const exited = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 15_000);
    proc.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  if (!exited && cmdProcess) {
    console.log("[bootstrap] Force-killing commandlet.");
    cmdProcess.kill();
    cmdProcess = null;
  }
}

export function cleanupTempProject(): void {
  if (!tempDir) return;
  const junctionPath = path.join(tempDir, "Plugins", "BlueprintMCP");

  // Remove the junction first — rmdir removes only the junction, not the target
  try {
    execSync(`cmd /c rmdir "${junctionPath}"`, { stdio: "ignore" });
  } catch { /* may already be gone */ }

  // Remove the rest of the temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`[bootstrap] Cleaned up ${tempDir}`);
  } catch (e) {
    console.error(`[bootstrap] Warning: could not clean up ${tempDir}:`, e);
  }
  tempDir = null;
}
