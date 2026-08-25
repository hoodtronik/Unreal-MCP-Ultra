import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { uePost, createTestBlueprint, deleteTestBlueprint, uniqueName } from "../helpers.js";

// CLAUDE-NOTE: regression tests for docs/KNOWN-ISSUE-wildcard-pins.md. Root cause was NOT the
// connection path: add_node spawned every function call as plain UK2Node_CallFunction, but the
// wildcard propagation for Array_Get/Array_Length lives in UK2Node_CallArrayFunction —
// the editor palette picks that subclass from the function's ArrayParm metadata
// (UBlueprintFunctionNodeSpawner::Create), and add_node now mirrors it.
describe("wildcard pin resolution (array function nodes)", () => {
  const bpName = uniqueName("BP_WildcardTest");
  const packagePath = "/Game/Test";
  let varGetNodeId: string;
  let arrayGetNodeId: string;

  beforeAll(async () => {
    const bp = await createTestBlueprint({ name: bpName });
    expect(bp.error).toBeUndefined();

    const varRes = await uePost("/api/add-variable", {
      blueprint: bpName,
      variableName: "Items",
      variableType: "string",
      isArray: true,
    });
    expect(varRes.error).toBeUndefined();

    const getRes = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "VariableGet",
      variableName: "Items",
    });
    expect(getRes.success).toBe(true);
    varGetNodeId = getRes.nodeId;
  });

  afterAll(async () => {
    await deleteTestBlueprint(`${packagePath}/${bpName}`);
  });

  it("spawns Array_Get as UK2Node_CallArrayFunction, not plain CallFunction", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CallFunction",
      className: "KismetArrayLibrary",
      functionName: "Array_Get",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.node?.class).toBe("K2Node_CallArrayFunction");
    arrayGetNodeId = data.nodeId;
  });

  it("resolves the wildcard TargetArray pin when a typed array is connected", async () => {
    const data = await uePost("/api/connect-pins", {
      blueprint: bpName,
      sourceNodeId: varGetNodeId,
      sourcePinName: "Items",
      targetNodeId: arrayGetNodeId,
      targetPinName: "TargetArray",
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    // The old bug: this stayed "wildcard" forever and the BP failed to compile with
    // "The type of Target Array is undetermined."
    expect(data.targetPinType).toBe("string");

    // Type must also propagate through to the Item output pin
    const pins = data.updatedTargetNode?.pins ?? [];
    const itemPin = pins.find((p: any) => p.name === "Item");
    expect(itemPin).toBeDefined();
    expect(itemPin.type).toBe("string");
  });

  it("compiles cleanly with Array_Length wired to the same typed array", async () => {
    const lenRes = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CallFunction",
      className: "KismetArrayLibrary",
      functionName: "Array_Length",
    });
    expect(lenRes.success).toBe(true);
    expect(lenRes.node?.class).toBe("K2Node_CallArrayFunction");

    const conn = await uePost("/api/connect-pins", {
      blueprint: bpName,
      sourceNodeId: varGetNodeId,
      sourcePinName: "Items",
      targetNodeId: lenRes.nodeId,
      targetPinName: "TargetArray",
    });
    expect(conn.success).toBe(true);
    expect(conn.targetPinType).toBe("string");

    const val = await uePost("/api/validate-blueprint", { blueprint: bpName });
    expect(val.error).toBeUndefined();
    expect(val.isValid).toBe(true);
  });

  it("still spawns non-array functions as plain UK2Node_CallFunction", async () => {
    const data = await uePost("/api/add-node", {
      blueprint: bpName,
      graph: "EventGraph",
      nodeType: "CallFunction",
      functionName: "PrintString",
    });
    expect(data.success).toBe(true);
    expect(data.node?.class).toBe("K2Node_CallFunction");
  });
});
