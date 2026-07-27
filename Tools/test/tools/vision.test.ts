import { describe, it, expect, beforeEach, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { uePost, describeEditorOnly } from "../helpers.js";
import { visionState, shouldAttach, resolveTarget, captureFrame } from "../../src/vision-state.js";
import { installVisionWrapper } from "../../src/vision-wrapper.js";

// Mocks only the src-side bridge used by captureFrame. The editor-only HTTP tests below go through
// test/helpers.ts, which has its own independent uePost, so they are unaffected.
vi.mock("../../src/ue-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  uePost: vi.fn(),
}));
const { uePost: mockedUePost } = await import("../../src/ue-bridge.js");

// CLAUDE-NOTE: the attach-policy and wrapper tests below need no UE5 backend at all, which is the
// point — the routing rules are where the real logic lives, and they should stay verifiable
// without a 60s commandlet boot. The HTTP round-trip tests are editor-only because capture needs
// an RHI, which the -nullrhi test commandlet does not have.

describe("vision attach policy", () => {
  beforeEach(() => {
    visionState.enabled = true;
    visionState.onReadOnly = false;
    visionState.targets = ["level"];
    visionState.suppressedReason = null;
    visionState.lastDigest = {};
  });

  it("skips everything when vision mode is off", () => {
    visionState.enabled = false;
    expect(shouldAttach("spawn_actor")).toBe(false);
  });

  it("attaches to state-changing tools", () => {
    expect(shouldAttach("spawn_actor")).toBe(true);
    expect(shouldAttach("set_actor_transform")).toBe(true);
    expect(shouldAttach("connect_pins")).toBe(true);
  });

  it("skips read-only tools by default", () => {
    expect(shouldAttach("get_blueprint")).toBe(false);
    expect(shouldAttach("list_actors")).toBe(false);
    expect(shouldAttach("describe_graph")).toBe(false);
    expect(shouldAttach("find_actors_by_class")).toBe(false);
    expect(shouldAttach("search_blueprints")).toBe(false);
    expect(shouldAttach("diff_graph")).toBe(false);
  });

  it("attaches to read-only tools when onReadOnly is set", () => {
    visionState.onReadOnly = true;
    expect(shouldAttach("get_blueprint")).toBe(true);
  });

  // Regression guard: validate_* compiles the Blueprint
  // (FKismetEditorUtilities::CompileBlueprint, BlueprintMCPHandlers_Validation.cpp), so a naive
  // prefix rule that treated "validate" as read-only would suppress the frame after a real change.
  it("treats validate_* as mutating despite the read-only-sounding name", () => {
    expect(shouldAttach("validate_blueprint")).toBe(true);
    expect(shouldAttach("validate_all_blueprints")).toBe(true);
  });

  it("never attaches to the vision tools themselves", () => {
    expect(shouldAttach("viewport_capture")).toBe(false);
    expect(shouldAttach("vision_mode")).toBe(false);
    expect(shouldAttach("scene_digest")).toBe(false);
    expect(shouldAttach("screenshot_graph")).toBe(false);
  });

  it("stops attaching once a hard capture failure has latched", () => {
    visionState.suppressedReason = "No render device";
    expect(shouldAttach("spawn_actor")).toBe(false);
  });
});

describe("vision target routing", () => {
  beforeEach(() => {
    visionState.enabled = true;
    visionState.targets = ["level", "graph"];
  });

  it("routes a blueprint+graph call to that specific graph", () => {
    expect(resolveTarget({ blueprint: "BP_Test", graph: "EventGraph", nodeType: "Branch" }))
      .toEqual({ target: "graph", blueprint: "BP_Test", graph: "EventGraph" });
  });

  it("routes a level-scoped call to the level viewport", () => {
    expect(resolveTarget({ actorName: "Cube", location: [0, 0, 0] })).toEqual({ target: "level" });
  });

  // A level frame after add_variable would be a provably unchanged image every single time.
  it("skips blueprint-scoped calls that have no graph", () => {
    expect(resolveTarget({ blueprint: "BP_Test", variableName: "Health" })).toBeNull();
  });

  it("skips graph calls when graph is not an enabled target", () => {
    visionState.targets = ["level"];
    expect(resolveTarget({ blueprint: "BP_Test", graph: "EventGraph" })).toBeNull();
  });

  it("skips level calls when level is not an enabled target", () => {
    visionState.targets = ["graph"];
    expect(resolveTarget({ actorName: "Cube" })).toBeNull();
  });
});

describe("vision wrapper", () => {
  function makeFakeServer() {
    const handlers: Record<string, (...a: any[]) => any> = {};
    const server = {
      tool(name: string, ..._rest: any[]) {
        handlers[name] = arguments[arguments.length - 1];
      },
    } as unknown as McpServer;
    return { server, handlers };
  }

  beforeEach(() => {
    visionState.enabled = false;
    visionState.suppressedReason = null;
  });

  it("passes the tool result through untouched when vision mode is off", async () => {
    const { server, handlers } = makeFakeServer();
    installVisionWrapper(server);
    server.tool("spawn_actor", "desc", {}, async () => ({
      content: [{ type: "text", text: "Spawned." }],
    }));

    const result = await handlers.spawn_actor({ actorName: "Cube" }, {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe("Spawned.");
  });

  it("still registers tools that have no handler-position surprises", async () => {
    const { server, handlers } = makeFakeServer();
    installVisionWrapper(server);
    // 2-arg overload: (name, handler)
    server.tool("bare_tool", async () => ({ content: [{ type: "text", text: "ok" }] }));
    expect(typeof handlers.bare_tool).toBe("function");
    const result = await handlers.bare_tool({});
    expect(result.content[0].text).toBe("ok");
  });

  it("does not attach a frame to an error result", async () => {
    visionState.enabled = true;
    const { server, handlers } = makeFakeServer();
    installVisionWrapper(server);
    server.tool("spawn_actor", "desc", {}, async () => ({
      content: [{ type: "text", text: "Error: no such class" }],
    }));

    const result = await handlers.spawn_actor({ actorName: "Nope" }, {});
    expect(result.content).toHaveLength(1);
    expect(result.content.some((c: any) => c.type === "image")).toBe(false);
  });
});

describe("capture failure latching", () => {
  beforeEach(() => {
    visionState.enabled = true;
    visionState.suppressedReason = null;
    visionState.lastDigest = {};
    vi.mocked(mockedUePost).mockReset();
  });

  // Regression guard: latching on ANY error meant a normal per-call miss — a graph that a tool
  // had just renamed, say — silently killed vision for the rest of the session.
  it("does not latch on a transient per-call error", async () => {
    vi.mocked(mockedUePost).mockResolvedValue({ error: "Graph 'EventGraph' not found in Blueprint 'BP_X'" });
    const frame = await captureFrame("graph", { blueprint: "BP_X", graph: "EventGraph" });
    expect(frame).toBeNull();
    expect(visionState.suppressedReason).toBeNull();
    expect(shouldAttach("spawn_actor")).toBe(true);
  });

  it("latches when there is no render device at all", async () => {
    vi.mocked(mockedUePost).mockResolvedValue({
      error: "No render device: the BlueprintMCP backend is running as a headless commandlet (-nullrhi)...",
    });
    const frame = await captureFrame("level", {});
    expect(frame).toBeNull();
    expect(visionState.suppressedReason).toContain("No render device");
    expect(shouldAttach("spawn_actor")).toBe(false);
  });

  it("never throws when the transport itself fails", async () => {
    vi.mocked(mockedUePost).mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(captureFrame("level", {})).resolves.toBeNull();
  });

  it("returns null and records the digest when the frame is unchanged", async () => {
    vi.mocked(mockedUePost).mockResolvedValue({ unchanged: true, digest: "384x216-deadbeef" });
    const frame = await captureFrame("level", { useDigest: true });
    expect(frame).toBeNull();
    expect(visionState.lastDigest.level).toBe("384x216-deadbeef");
  });

  it("returns the frame when the image payload is present", async () => {
    vi.mocked(mockedUePost).mockResolvedValue({
      success: true, digest: "384x216-01234567", imageBase64: "aGVsbG8=",
      width: 384, height: 216, elapsedMs: 22, target: "level",
    });
    const frame = await captureFrame("level", {});
    expect(frame?.base64).toBe("aGVsbG8=");
    expect(frame?.width).toBe(384);
  });
});

describeEditorOnly("viewport_capture / scene_digest (HTTP)", () => {
  describe("viewport_capture", () => {
    it("returns inline base64 PNG bytes, not a file path", async () => {
      const data = await uePost("/api/viewport-capture", { target: "level", maxSize: 384 });
      expect(data.error).toBeUndefined();
      expect(data.success).toBe(true);
      expect(data.mimeType).toBe("image/png");
      expect(typeof data.imageBase64).toBe("string");
      expect(data.imageBase64.length).toBeGreaterThan(100);
      expect(data.fullPath).toBeUndefined();
    });

    it("honours the maxSize longest-edge clamp", async () => {
      const data = await uePost("/api/viewport-capture", { target: "level", maxSize: 256 });
      expect(data.error).toBeUndefined();
      expect(Math.max(data.width, data.height)).toBeLessThanOrEqual(256);
    });

    it("suppresses the payload when the digest is unchanged", async () => {
      const first = await uePost("/api/viewport-capture", { target: "level", maxSize: 256 });
      expect(first.error).toBeUndefined();
      const second = await uePost("/api/viewport-capture", {
        target: "level",
        maxSize: 256,
        sinceDigest: first.digest,
      });
      expect(second.unchanged).toBe(true);
      expect(second.imageBase64).toBeUndefined();
      expect(second.digest).toBe(first.digest);
    });

    it("rejects target='graph' without blueprint and graph", async () => {
      const data = await uePost("/api/viewport-capture", { target: "graph" });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("invalid_input");
    });

    it("rejects an unknown target", async () => {
      const data = await uePost("/api/viewport-capture", { target: "niagara" });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("invalid_input");
    });
  });

  describe("scene_digest", () => {
    it("returns a level digest", async () => {
      const data = await uePost("/api/scene-digest", { scope: "level" });
      expect(data.error).toBeUndefined();
      expect(typeof data.digest).toBe("string");
      expect(typeof data.actorCount).toBe("number");
      expect(typeof data.pieRunning).toBe("boolean");
    });

    it("is stable across two calls with no intervening change", async () => {
      const a = await uePost("/api/scene-digest", { scope: "level" });
      const b = await uePost("/api/scene-digest", { scope: "level" });
      expect(a.digest).toBe(b.digest);
    });

    it("rejects scope='graph' without blueprint and graph", async () => {
      const data = await uePost("/api/scene-digest", { scope: "graph" });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("invalid_input");
    });

    it("rejects an unknown scope", async () => {
      const data = await uePost("/api/scene-digest", { scope: "material" });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("invalid_input");
    });
  });
});
