import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { uePost, createTestBlueprint, deleteTestBlueprint, uniqueName } from "../helpers.js";

describe("add_node", () => {
  const bpName = uniqueName("BP_AddNodeTest");
  const packagePath = "/Game/Test";

  beforeAll(async () => {
    const res = await createTestBlueprint({ name: bpName });
    expect(res.error).toBeUndefined();
  });

  afterAll(async () => {
    await deleteTestBlueprint(`${packagePath}/${bpName}`);
  });

  it("adds a function call node (PrintString)", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CallFunction",
      functionName: "PrintString",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.nodeType).toBe("CallFunction");
    expect(data.saved).toBe(true);
  });

  it("adds an event override node (BeginPlay)", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "OverrideEvent",
      functionName: "ReceiveBeginPlay",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    // A fresh Actor BP already has ReceiveBeginPlay, so the server
    // returns the existing node with alreadyExists=true and no saved field.
    if (data.alreadyExists) {
      expect(data.alreadyExists).toBe(true);
      // CLAUDE-NOTE: regression check for the ghost-node fix (github.com/mirno-ehf/ue5-mcp#70).
      // A fresh Actor BP auto-places ReceiveBeginPlay as a disabled "ghost" stub — its NodeComment
      // is UE's literal "This node is disabled and will not be called..." text. add_node's
      // already-exists branch must permanently promote it (SetEnabledState(Enabled, bUserAction=true)
      // + clear the comment) so it can't later be silently re-ghosted (which was observed to also
      // clear the node's own and its downstream nodes' pin connections). SerializeNode omits the
      // 'comment' field entirely once NodeComment is empty, so its absence here is the assertion.
      expect(data.node?.comment).toBeUndefined();
    } else {
      expect(data.saved).toBe(true);
    }
  });

  it("rejects missing required fields", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      // missing graph and nodeType
    });
    expect(data.error).toBeDefined();
  });

  it("rejects non-existent blueprint", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: "BP_Nonexistent_XYZ_999",
      graph: "EventGraph",
      nodeType: "CallFunction",
      functionName: "PrintString",
    });
    expect(data.error).toBeDefined();
  });

  it("rejects non-existent graph", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "FakeGraph",
      nodeType: "CallFunction",
      functionName: "PrintString",
    });
    expect(data.error).toBeDefined();
    expect(data.availableGraphs).toBeDefined();
  });

  // --- New node types ---

  it("adds a Branch node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "Branch",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
    // Branch should have Condition input pin and True/False output pins
    const pins = data.node?.pins || data.pins || [];
    const pinNames = pins.map((p: any) => p.name);
    expect(pinNames).toContain("Condition");
  });

  it("adds a Sequence node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "Sequence",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a CustomEvent node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CustomEvent",
      eventName: "TestCustomEvent",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a CustomEvent with callInEditor (Details-panel button)", async () => {
    // CLAUDE-NOTE: regression test for docs/KNOWN-ISSUE-call-in-editor.md — bCallInEditor is a
    // bare UPROPERTY unreachable from editor python, so add_node's callInEditor option is the
    // only scriptable path. The node JSON echoing it back is also the read-back path.
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CustomEvent",
      eventName: "TestEditorButton",
      callInEditor: true,
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.node?.callInEditor).toBe(true);
    // Also locks in the SerializeNode branch-order fix: custom events used to be swallowed by
    // the generic UK2Node_Event branch and reported as nodeType "Event".
    expect(data.node?.nodeType).toBe("CustomEvent");
  });

  it("defaults callInEditor to false when omitted", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CustomEvent",
      eventName: "TestPlainEvent",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.node?.callInEditor).toBe(false);
    expect(data.node?.nodeType).toBe("CustomEvent");
  });

  it("rejects CustomEvent without eventName", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CustomEvent",
    });
    expect(data.error).toBeDefined();
  });

  it("adds a ForEachLoop node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "ForEachLoop",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a ForLoop node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "ForLoop",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a ForLoopWithBreak node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "ForLoopWithBreak",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a WhileLoop node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "WhileLoop",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a SpawnActorFromClass node without actorClass", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "SpawnActorFromClass",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a Select node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "Select",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a Comment node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "Comment",
      comment: "Test Section",
      width: 500,
      height: 300,
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a Comment node with defaults", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "Comment",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });

  it("adds a Reroute node", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "Reroute",
      posX: 300,
      posY: 200,
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.nodeId).toBeDefined();
    expect(data.saved).toBe(true);
  });
});
