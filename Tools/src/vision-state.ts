import { uePost } from "./ue-bridge.js";

// CLAUDE-NOTE: session-level vision state. This is a session PREFERENCE, not an argument to any
// one tool — the agent turns it on once and every subsequent state-changing call carries a frame.
// Making it a per-tool parameter would mean the agent has to remember to ask for a picture, which
// is exactly the behavior (working blind off state queries) the feature exists to fix.

export type CaptureTarget = "level" | "pie" | "graph";
export type AutoTarget = "level" | "graph";

export interface VisionState {
  enabled: boolean;
  maxSize: number;
  targets: AutoTarget[];
  onReadOnly: boolean;
  /** Last pixel digest per target key, used to suppress duplicate frames. */
  lastDigest: Record<string, string>;
  /** Set after a hard capture failure so a doomed setup doesn't retry 228 times. */
  suppressedReason: string | null;
}

export const visionState: VisionState = {
  enabled: false,
  maxSize: 384,
  // CLAUDE-NOTE: graph is OFF by default and that is a deliberate departure from the Blender
  // design this was ported from. Blender has one viewport that every tool affects, so a global
  // always-on frame is nearly free. Here a legible graph frame needs ~1024px (~1000 tokens vs
  // ~150 for a level frame) AND digest suppression cannot help, because a graph edit changes the
  // graph every single time. Twenty add_node calls would be ~20k tokens of auto-attached images.
  targets: ["level"],
  onReadOnly: false,
  lastDigest: {},
  suppressedReason: null,
};

// --- Attach policy ---

// CLAUDE-NOTE: the authoritative "does this change state" set already exists in C++ —
// MutationEndpoints in BlueprintMCPServer.cpp, ~125 entries, kept correct because it drives undo
// transaction wrapping. It is not reusable here: it is keyed by HTTP endpoint name (addNode),
// while the wrapper only ever sees MCP tool names (add_node), and there is no name-addressable
// mapping between them. So this is a prefix rule plus the exceptions found by reading the
// handlers. If a tool is misclassified the cost is a wasted frame or a missed one, never a wrong
// result — the capture is strictly additive to the tool's own output.
const READ_ONLY_PREFIXES = [
  "get_", "list_", "describe_", "find_", "search_", "check_", "is_", "diff_", "discover_",
  "validate_",
];

// Read-only by name, mutating in fact. Checked BEFORE the prefix list, which is why "validate_"
// can sit in READ_ONLY_PREFIXES while these two stay classified as mutations.
const MUTATES_DESPITE_NAME = new Set([
  // FKismetEditorUtilities::CompileBlueprint — see BlueprintMCPHandlers_Validation.cpp:90.
  "validate_blueprint",
  "validate_all_blueprints",
]);

// Our own tools, plus anything whose result is already an image or would recurse.
const NEVER_ATTACH = new Set([
  "viewport_capture", "vision_mode", "scene_digest",
  "take_screenshot", "take_high_res_screenshot", "screenshot_graph",
  "server_status", "shutdown_server",
]);

export function shouldAttach(toolName: string): boolean {
  if (!visionState.enabled) return false;
  if (visionState.suppressedReason) return false;
  if (NEVER_ATTACH.has(toolName)) return false;
  if (MUTATES_DESPITE_NAME.has(toolName)) return true;

  const isReadOnly = READ_ONLY_PREFIXES.some((p) => toolName.startsWith(p));
  return isReadOnly ? visionState.onReadOnly : true;
}

/**
 * Pick what to look at from the tool's own arguments.
 *
 * CLAUDE-NOTE: this is the main structural change from the Blender design. There, "the viewport"
 * is unambiguous. Here the majority of tools (add_node, connect_pins, set_pin_default, variables,
 * structs, material graphs) have no effect whatsoever on the level viewport — auto-attaching a
 * level frame to add_node is a provably unchanged image, forever. But the graph tools already
 * carry `blueprint` and `graph` in their arguments, which is exactly what a graph capture needs,
 * so the target can be inferred from the call instead of configured globally.
 */
export function resolveTarget(args: unknown): { target: AutoTarget; blueprint?: string; graph?: string } | null {
  const a = (args ?? {}) as Record<string, unknown>;

  if (typeof a.blueprint === "string" && typeof a.graph === "string") {
    if (!visionState.targets.includes("graph")) return null;
    return { target: "graph", blueprint: a.blueprint, graph: a.graph };
  }

  // A blueprint-scoped tool with no graph (add_variable, add_component…) changes nothing the
  // level viewport shows either. Skip rather than attach a stale-looking level frame.
  if (typeof a.blueprint === "string") return null;

  if (!visionState.targets.includes("level")) return null;
  return { target: "level" };
}

// --- Capture ---

/**
 * Error substrings that mean capture cannot work for this session at all, as opposed to failing
 * for this one call. Kept in sync with the messages in HandleViewportCapture.
 */
const PERMANENT_FAILURES = [
  "No render device",
  "No level editor viewport is open",
];

export interface CapturedFrame {
  base64: string;
  digest: string;
  width: number;
  height: number;
  elapsedMs: number;
  target: string;
}

/**
 * Capture a frame, or return null. NEVER throws.
 *
 * CLAUDE-NOTE: a failed screenshot must never turn a successful edit into an error. The tool the
 * agent actually called has already run and already succeeded by the time this is reached; the
 * frame is a courtesy. Every failure path here is swallowed, and a hard failure latches
 * suppressedReason so a headless session doesn't pay the round trip 228 more times.
 */
export async function captureFrame(
  target: CaptureTarget,
  opts: { blueprint?: string; graph?: string; maxSize?: number; useDigest?: boolean } = {},
): Promise<CapturedFrame | null> {
  const key = target === "graph" ? `graph:${opts.blueprint}:${opts.graph}` : target;
  const maxSize = opts.maxSize ?? visionState.maxSize;

  try {
    const body: Record<string, unknown> = { target, maxSize };
    if (opts.blueprint) body.blueprint = opts.blueprint;
    if (opts.graph) body.graph = opts.graph;
    if (opts.useDigest && visionState.lastDigest[key]) {
      body.sinceDigest = visionState.lastDigest[key];
    }

    const data = await uePost("/api/viewport-capture", body);

    if (data?.error) {
      // CLAUDE-NOTE: only latch on conditions that are structural for this session — no render
      // device, or no viewport to read. Latching on ANY error was wrong: a per-call failure like
      // "Graph 'X' not found" (entirely normal when a tool creates or renames a graph and the
      // auto-attach races it) would silently disable vision for the rest of the session, and the
      // user would never learn why frames stopped appearing.
      const message = String(data.error);
      if (PERMANENT_FAILURES.some((p) => message.includes(p))) {
        visionState.suppressedReason = message;
      }
      return null;
    }

    if (data?.digest) visionState.lastDigest[key] = data.digest;
    if (data?.unchanged || !data?.imageBase64) return null;

    return {
      base64: data.imageBase64,
      digest: data.digest,
      width: data.width,
      height: data.height,
      elapsedMs: data.elapsedMs,
      target: data.target,
    };
  } catch {
    return null;
  }
}
