import { describe, it, expect } from "vitest";
import { uePost } from "../helpers.js";

// The headless test project has no landscape, so the success path is verified live (see the
// CLAUDE-NOTE in Tools/src/tools/landscape.ts); here we pin the validation and error contract.
describe("landscape heightmap tools", () => {
  describe("landscape_import_heightmap", () => {
    it("returns error for missing file field", async () => {
      const data = await uePost("/api/landscape-import-heightmap", {});
      expect(data.error).toBeDefined();
      expect(data.error).toContain("file");
    });

    it("returns error when the level has no matching landscape", async () => {
      const data = await uePost("/api/landscape-import-heightmap", {
        file: "C:/does/not/exist.r16",
        landscape: "NoSuchLandscape_xyz",
        dryRun: true,
      });
      expect(data.error).toBeDefined();
      expect(data.error.toLowerCase()).toContain("landscape");
    });
  });

  describe("landscape_export_heightmap", () => {
    it("returns error for missing file field", async () => {
      const data = await uePost("/api/landscape-export-heightmap", {});
      expect(data.error).toBeDefined();
      expect(data.error).toContain("file");
    });

    it("returns error when the level has no matching landscape", async () => {
      const data = await uePost("/api/landscape-export-heightmap", {
        file: "C:/temp/out.r16",
        landscape: "NoSuchLandscape_xyz",
      });
      expect(data.error).toBeDefined();
      expect(data.error.toLowerCase()).toContain("landscape");
    });
  });
});
