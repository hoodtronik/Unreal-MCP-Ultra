import { describe, it, expect } from "vitest";
import { uePost, describeEditorOnly, IS_EDITOR_MODE } from "../helpers.js";

describe("editor UI tools (any mode)", () => {
  it("ui_set_text requires text", async () => {
    const data = await uePost("/api/ui-set-text", {});
    expect(data.error).toBeDefined();
  });

  it("ui_click requires text", async () => {
    const data = await uePost("/api/ui-click", {});
    expect(data.error).toBeDefined();
  });

  it.skipIf(IS_EDITOR_MODE)("ui_find reports that the commandlet has no UI", async () => {
    const data = await uePost("/api/ui-find", {});
    expect(data.error).toContain("editor UI");
  });
});

describeEditorOnly("editor UI tools (editor)", () => {
  it("ui_find lists windows and widgets", async () => {
    const data = await uePost("/api/ui-find", { max: 5 });
    expect(data.error).toBeUndefined();
    expect(data.roots.length).toBeGreaterThan(0);
    expect(typeof data.count).toBe("number");
    expect(data.elements.length).toBeLessThanOrEqual(5);
  });

  it("ui_find names the open windows when the root is unknown", async () => {
    const data = await uePost("/api/ui-find", { root: "No_Such_Window_XYZ_999" });
    expect(data.error).toContain("No window or tab");
    expect(Array.isArray(data.windowTitles)).toBe(true);
  });

  it("ui_set_text reports a missing text box", async () => {
    const data = await uePost("/api/ui-set-text", { target: "No_Such_Box_XYZ_999", text: "x" });
    expect(data.error).toContain("No text box");
  });

  it("ui_click reports a missing widget", async () => {
    const data = await uePost("/api/ui-click", { text: "No_Such_Button_XYZ_999" });
    expect(data.error).toContain("No button or checkbox");
  });
});
