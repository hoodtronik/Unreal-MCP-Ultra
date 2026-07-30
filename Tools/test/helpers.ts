import { describe } from "vitest";
/**
 * helpers.ts — HTTP wrappers and fixture management for integration tests.
 */

import { TEST_BASE_URL } from "./bootstrap.js";

// ---------------------------------------------------------------------------
// HTTP helpers (mirror the production ueGet/uePost in src/index.ts)
// ---------------------------------------------------------------------------

export async function ueGet(
  endpoint: string,
  params: Record<string, string> = {},
): Promise<any> {
  const url = new URL(endpoint, TEST_BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  const resp = await fetch(url.toString(), {
    signal: AbortSignal.timeout(30_000),
  });
  return resp.json();
}

// CLAUDE-NOTE: the 30s default is a client-side ceiling, not a server limit, and it suits endpoints
// that touch a handful of fixtures. Whole-project sweeps instead scale with the HOST ENGINE's asset
// count, which is not constant across engine versions — an unfiltered /api/validate-all-blueprints
// passed on 5.6 but exceeds 30s on 5.8, which ships far more Blueprint-bearing plugins (26 Toolsets,
// ModelContextProtocol, MetaHuman). Raising the global default would mask genuine hangs, so the
// timeout is per-call and only the known-unbounded sweep opts into a longer one.
export async function uePost(
  endpoint: string,
  body: Record<string, any>,
  timeoutMs: number = 30_000,
): Promise<any> {
  const resp = await fetch(`${TEST_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return resp.json();
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Generate a unique Blueprint name using a prefix and timestamp. */
export function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}`;
}

/**
 * Create a test Blueprint via the HTTP API.
 * Returns the full JSON response from /api/create-blueprint.
 */
export async function createTestBlueprint(opts: {
  name: string;
  packagePath?: string;
  parentClass?: string;
  blueprintType?: string;
}): Promise<any> {
  return uePost("/api/create-blueprint", {
    blueprintName: opts.name,
    packagePath: opts.packagePath ?? "/Game/Test",
    parentClass: opts.parentClass ?? "Actor",
    blueprintType: opts.blueprintType ?? "Normal",
  });
}

/**
 * Delete a test Blueprint via the HTTP API (force = true to skip reference checks).
 * Returns the full JSON response from /api/delete-asset.
 */
export async function deleteTestBlueprint(
  assetPath: string,
): Promise<any> {
  return uePost("/api/delete-asset", {
    assetPath,
    force: true,
  });
}

/**
 * Create a test Material via the HTTP API.
 */
export async function createTestMaterial(opts: {
  name: string;
  packagePath?: string;
  domain?: string;
  blendMode?: string;
}): Promise<any> {
  return uePost("/api/create-material", {
    name: opts.name,
    packagePath: opts.packagePath ?? "/Game/Test",
    domain: opts.domain ?? "Surface",
    blendMode: opts.blendMode ?? "Opaque",
  });
}

/**
 * Delete a test Material via the HTTP API.
 */
export async function deleteTestMaterial(assetPath: string): Promise<any> {
  return uePost("/api/delete-asset", {
    assetPath,
    force: true,
  });
}

/**
 * Create a test Material Instance via the HTTP API.
 */
export async function createTestMaterialInstance(opts: {
  name: string;
  packagePath?: string;
  parentMaterial: string;
}): Promise<any> {
  return uePost("/api/create-material-instance", {
    name: opts.name,
    packagePath: opts.packagePath ?? "/Game/Test",
    parentMaterial: opts.parentMaterial,
  });
}


/**
 * Create a test Material Function via the HTTP API.
 */
export async function createTestMaterialFunction(opts: {
  name: string;
  packagePath?: string;
  description?: string;
}): Promise<any> {
  return uePost("/api/create-material-function", {
    name: opts.name,
    packagePath: opts.packagePath ?? "/Game/Test",
    description: opts.description ?? "",
  });
}

/**
 * Create a test Widget Blueprint via the HTTP API.
 */
export async function createTestWidgetBlueprint(opts: {
  name: string;
  packagePath?: string;
}): Promise<any> {
  return uePost("/api/create-widget-blueprint", {
    name: opts.name,
    packagePath: opts.packagePath ?? "/Game/Test",
  });
}

/**
 * Create a test Animation Blueprint via the HTTP API.
 */
export async function createTestAnimBlueprint(opts: {
  name: string;
  packagePath?: string;
  skeleton?: string;
  parentClass?: string;
}): Promise<any> {
  return uePost("/api/create-anim-blueprint", {
    name: opts.name,
    packagePath: opts.packagePath ?? "/Game/Test",
    skeleton: opts.skeleton ?? "__create_test_skeleton__",
    parentClass: opts.parentClass ?? "AnimInstance",
  });
}

// CLAUDE-NOTE: the suite runs a headless `-nullrhi` commandlet, which has no viewport, no PIE
// session and no loaded map. Editor-only tools correctly refuse with "<tool> requires editor
// mode.", so those tests can never pass here. They were FAILING rather than skipping, which
// left a permanently red suite that people learn to ignore. Gate those suites with
// `describeEditorOnly` so they report as skipped in commandlet mode and still run for anyone
// pointing the tests at a live editor.
const health = await ueGet("/api/health", {}).catch(() => null);

/** True when the backend is a real editor rather than the headless test commandlet. */
export const IS_EDITOR_MODE: boolean = health?.mode === "editor";

/** `describe` that skips unless the backend is a full editor. */
export const describeEditorOnly = IS_EDITOR_MODE ? describe : describe.skip;
