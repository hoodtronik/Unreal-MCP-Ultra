import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

// CLAUDE-NOTE (2026-10-22): Pose Search / Motion Matching through the optional sibling plugin BlueprintMCPPoseSearch
// (PoseSearchExt/ in this repo; install as <Project>/Plugins/BlueprintMCPPoseSearch with the PoseSearch plugin on).
// Python cannot author these assets (factories need a modal picker; the schema skeleton and database clip list are
// invisible to Python; the index is built in C++), so both tools call /api/posesearch-*. The check is an offline
// nearest-pose search over the built index: a pose must find itself at cost ~0, and excluding its own clip shows what
// a character in that pose would switch to.

export const SELF_COST_TOL = 1e-4;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
const short = (p: string) => (p || "").split(".")[0].split("/").pop();
const NOT_INSTALLED = "The BlueprintMCPPoseSearch sibling plugin is not loaded (copy PoseSearchExt to <Project>/Plugins/BlueprintMCPPoseSearch, enable PoseSearch, restart).";

async function post(route: string, body: Record<string, unknown>): Promise<any> {
  const r = await uePost(route, body);
  if (r && typeof r.error === "string" && /not found|404|No handler|unknown endpoint/i.test(r.error) && /posesearch/i.test(route) && !r.database) {
    return { ...r, error: `${r.error} - ${NOT_INSTALLED}` };
  }
  return r;
}

export function registerPoseSearchTools(server: McpServer): void {
  server.tool(
    "pose_search_build",
    "Build a POSE SEARCH (Motion Matching) database from clips: creates or updates the schema (skeleton + default " +
      "trajectory and foot channels, sample rate) and the database (clips, brute-force search), saves both and builds " +
      "the index (waits). Reports channels, pose count per clip and checks every clip got indexed poses.",
    {
      schema: z.string().describe("Schema asset path, e.g. /Game/Anims/PSS_Loco."),
      database: z.string().describe("Database asset path, e.g. /Game/Anims/PSD_Loco."),
      skeleton: z.string().describe("Skeleton asset path."),
      sequences: z.array(z.string()).min(1).describe("AnimSequence paths to index."),
      sampleRate: z.number().int().optional().describe("Schema sample rate (Hz). Default 30."),
      replace: z.boolean().optional().describe("Replace the database's clip list (default true)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await post("/api/posesearch-build", { ...a, replace: a.replace ?? true });
      if (r.error) return text(`Error: ${r.error}`, true);
      const lines = [
        `${r.databaseCreated ? "Created" : "Updated"} ${short(r.database)} (schema ${short(r.schema)}${r.schemaCreated ? ", created" : ""}): build ${r.build}, ${r.poses ?? 0} poses at ${r.sampleRate} Hz, cardinality ${r.cardinality}.`,
        `  channels: ${(r.channels ?? []).map((c: string) => c.replace("PoseSearchFeatureChannel_", "")).join(", ")}; skeletons: ${(r.skeletons ?? []).map(short).join(", ")}`,
      ];
      const empty: string[] = [];
      for (const c of r.perAsset ?? []) {
        lines.push(`  ${short(c.asset)}: ${c.poses} poses (${Number(c.length).toFixed(2)} s)`);
        if (!(c.poses > 0)) empty.push(short(c.asset)!);
      }
      const ok = r.success && r.build === "Success" && empty.length === 0 && (r.perAsset ?? []).length === a.sequences.length;
      if (empty.length) lines.push(`  NO POSES for ${empty.join(", ")} - clips shorter than the trimmed end (0.3 s) index nothing.`);
      return text([`${ok ? "Verified" : "BUILD PROBLEM"}:`, ...lines].join("\n"), !ok);
    },
  );

  server.tool(
    "pose_search_query",
    "Offline nearest-pose search in a built Pose Search database (no PIE needed): takes the indexed pose of `sequence` " +
      "at `time` and finds the closest pose by feature cost. With excludeSameAsset it reports which OTHER clip and time " +
      "motion matching would pick from that pose (transition candidates). Without it the pose must find itself (cost ~0).",
    {
      database: z.string(),
      queries: z.array(z.object({ sequence: z.string(), time: z.number() }).strict()).min(1).max(20),
      excludeSameAsset: z.boolean().optional(),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const lines: string[] = [];
      let bad = 0;
      for (const q of a.queries) {
        const r = await post("/api/posesearch-query", { database: a.database, sequence: q.sequence, time: q.time, excludeSameAsset: !!a.excludeSameAsset });
        if (r.error) { lines.push(`  ${short(q.sequence)} @${q.time}s: Error: ${r.error}`); bad++; continue; }
        const selfOk = r.selfCost <= SELF_COST_TOL;
        const found = a.excludeSameAsset ? true : (r.bestPose === r.queryPose || r.bestCost <= SELF_COST_TOL);
        if (!selfOk || !found) bad++;
        lines.push(`  ${short(q.sequence)} @${q.time}s (pose ${r.queryPose}, indexed at ${Number(r.queryAssetTime).toFixed(3)}s; self cost ${Number(r.selfCost).toExponential(1)}) -> ` +
          `${short(r.bestAsset)} @${Number(r.bestTime).toFixed(3)}s cost ${Number(r.bestCost).toFixed(4)}${!selfOk || !found ? "  <- FAIL" : ""}`);
      }
      return text([`${bad ? `QUERY PROBLEMS (${bad})` : "Queries verified"} on ${short(a.database)}${a.excludeSameAsset ? " (excluding each query's own clip)" : ""}:`, ...lines].join("\n"), bad > 0);
    },
  );
}
