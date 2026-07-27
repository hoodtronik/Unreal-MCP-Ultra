import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const PLUGIN_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const PRIVATE_DIR = path.resolve(PLUGIN_ROOT, "Source", "BlueprintMCP", "Private");

// CLAUDE-NOTE: same reasoning as route-parity.test.ts, for a bug class found live on 2026-07-27.
// GEditor->GetLevelViewportClients() includes clients that are not currently laid out, and those
// report GetSizeXY() as 0x0 — so indexing the array directly picks an unusable viewport whenever
// the editor is in that state. Six handlers had independently written [0]: both capture paths,
// get/set_viewport_camera, take_high_res_screenshot, and the file-local helper behind
// set_view_mode / set_show_flags / set_realtime_rendering / set_game_view / set_viewport_type.
//
// The individual breakage was bad, but the INCONSISTENCY was worse: once the capture path resolved
// the active sized viewport while the view-mode helper still used [0], the two could resolve
// DIFFERENT viewports, so set_view_mode reported success, acted on a viewport nobody was looking
// at, and a following viewport_capture legitimately showed no change.
//
// None of this is reachable by the integration suite — the test commandlet runs with -nullrhi and
// has no viewport at all — so a static source check is the only thing that can hold the line.
// Everything must go through FBlueprintMCPServer::ResolveSizedLevelViewportClient.

const INDEXED_ACCESS = /GetLevelViewportClients\s*\(\s*\)\s*\[/;

/** The one place allowed to iterate the array is the shared resolver itself. */
const RESOLVER_FILE = "BlueprintMCPHandlers_Screenshot.cpp";

function cppSources(): string[] {
  return fs
    .readdirSync(PRIVATE_DIR)
    .filter((f) => f.endsWith(".cpp"))
    .map((f) => path.join(PRIVATE_DIR, f));
}

/** Strip // and /* *​/ comments so the CLAUDE-NOTEs describing the bug don't trip the check. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

describe("level viewport resolution invariant", () => {
  const files = cppSources();

  it("found C++ sources to scan (guards against the test silently passing on nothing)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("no handler indexes GetLevelViewportClients() directly", () => {
    const offenders = files
      .filter((file) => INDEXED_ACCESS.test(stripComments(fs.readFileSync(file, "utf-8"))))
      .map((file) => path.basename(file))
      .sort();

    expect(
      offenders,
      "Use FBlueprintMCPServer::ResolveSizedLevelViewportClient (or ResolveCaptureViewport) " +
        "instead — indexing the array picks a viewport that may be unrealized and 0x0, and makes " +
        "this tool disagree with every other viewport tool about which viewport it is acting on.",
    ).toEqual([]);
  });

  it("only the shared resolver iterates the viewport client array", () => {
    const iterators = files
      .filter((file) => /GetLevelViewportClients\s*\(\s*\)/.test(stripComments(fs.readFileSync(file, "utf-8"))))
      .map((file) => path.basename(file))
      .sort();

    expect(iterators).toEqual([RESOLVER_FILE]);
  });

  it("the shared resolver actually exists and is declared in the public header", () => {
    const header = fs.readFileSync(
      path.resolve(PLUGIN_ROOT, "Source", "BlueprintMCP", "Public", "BlueprintMCPServer.h"),
      "utf-8",
    );
    expect(header).toContain("ResolveSizedLevelViewportClient");
    expect(header).toContain("ResolveCaptureViewport");

    const resolver = fs.readFileSync(path.join(PRIVATE_DIR, RESOLVER_FILE), "utf-8");
    expect(resolver).toContain("FBlueprintMCPServer::ResolveSizedLevelViewportClient");
    expect(resolver).toContain("FBlueprintMCPServer::ResolveCaptureViewport");
  });

  // The resolver is only correct if it actually rejects zero-sized viewports; if that check is
  // ever dropped the invariant above becomes decorative.
  it("the resolver still rejects zero-sized viewports", () => {
    const resolver = fs.readFileSync(path.join(PRIVATE_DIR, RESOLVER_FILE), "utf-8");
    const body = resolver.slice(resolver.indexOf("FBlueprintMCPServer::ResolveSizedLevelViewportClient"));
    expect(body).toMatch(/Size\.X\s*<=\s*0\s*\|\|\s*Size\.Y\s*<=\s*0/);
    expect(body).toContain("GetActiveViewport");
  });
});
