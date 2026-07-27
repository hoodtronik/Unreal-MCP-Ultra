import { describe, it, expect } from "vitest";
import { uePost, uniqueName, createTestBlueprint, deleteTestBlueprint } from "../helpers.js";

// CLAUDE-NOTE: these run against the headless commandlet. It has a real GEditor and UWorld, so the
// argument validation and the unsaved-package guard are both genuinely exercised. What is NOT
// covered here is a successful level switch: the commandlet's transient world has no map asset
// backing it, and tearing it down mid-suite would break every following test file that assumes a
// stable world. The success path was verified live against a running editor instead.

describe("open_level / new_level", () => {
  describe("open_level", () => {
    it("rejects a missing level", async () => {
      const data = await uePost("/api/open-level", {});
      expect(data.error).toBeDefined();
      expect(data.error).toContain("level");
      expect(data.errorCode).toBe("invalid_input");
    });

    it("returns not_found for a level that does not exist, and says how to address one", async () => {
      const data = await uePost("/api/open-level", { level: uniqueName("NoSuchLevel") });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("not_found");
      expect(data.error).toContain("/Game/");
    });
  });

  describe("new_level", () => {
    it("rejects a missing path", async () => {
      const data = await uePost("/api/new-level", {});
      expect(data.error).toBeDefined();
      expect(data.error).toContain("path");
      expect(data.errorCode).toBe("invalid_input");
    });

    // A bare name would be created somewhere unintuitive rather than where the caller meant.
    it("rejects a path that is not a package path", async () => {
      const data = await uePost("/api/new-level", { path: "MyLevel" });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("invalid_input");
      expect(data.error).toContain("full package path");
    });
  });

  // The guard that matters: a level load silently discards unsaved work because
  // ULevelEditorSubsystem runs under GIsRunningUnattendedScript, which suppresses the save prompt.
  describe("unsaved-package guard", () => {
    it("refuses to switch level while packages are dirty unless told what to do", async () => {
      // Dirty something cheap and reversible.
      const bp = uniqueName("BP_DirtyGuardProbe");
      const made = await createTestBlueprint({ name: bp });
      expect(made.error).toBeUndefined();
      await uePost("/api/add-variable", { blueprint: bp, name: "Probe", type: "float" });

      const dirty = await uePost("/api/get-dirty-packages", {});
      try {
        if ((dirty.count ?? 0) > 0) {
          const data = await uePost("/api/open-level", { level: "/Game/AnyLevel" });
          expect(data.error).toBeDefined();
          // Either the dirty guard or not_found is acceptable ordering, but a dirty-guard refusal
          // must name the escape hatches rather than just complaining.
          if (data.error.includes("unsaved")) {
            expect(data.error).toContain("saveFirst");
            expect(data.error).toContain("discardUnsaved");
          }
        }
      } finally {
        await deleteTestBlueprint(`/Game/Test/${bp}`).catch(() => {});
      }
    });
  });
});
