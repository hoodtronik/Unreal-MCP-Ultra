import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): skeletal MESH FBX in/out (Tools/python/ue_meshfbx.py). Manny exported (4.3 MB)
// and re-imported: 48705 vertices both, bounds identical, reference pose 0 cm; on a NEW skeleton it carries only the
// mesh's 89 bones (the shared SK_Mannequin has 161), onto SK_Mannequin it shares all 161 and the walk clip posed the
// imported mesh exactly like the original (0 cm, both paused at 0.5 s).

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_take.py", "ue_rtlive.py", "ue_meshfbx.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function registerSkelFbxTools(server: McpServer): void {
  server.tool(
    "skel_fbx",
    "SKELETAL MESH FBX: import a character mesh .fbx (onto an existing skeleton so its clips play directly, or with a " +
      "new skeleton), optionally exporting a mesh first (`exportMesh` -> `file`). VERIFIED against a reference mesh " +
      "(`compareTo`, default the exported mesh): bone set, vertex count, bounds, reference pose; with `clip` both meshes " +
      "play it paused at the same time and every bone is compared.",
    {
      file: z.string().describe("Absolute .fbx path (written when exportMesh is given)."),
      exportMesh: z.string().optional().describe("SkeletalMesh to export to `file` first."),
      importAs: z.string().describe("Destination asset path, e.g. /Game/Characters/Hero/SKM_Hero."),
      skeleton: z.string().optional().describe("Existing Skeleton to import onto (default: create one)."),
      materials: z.boolean().optional(),
      compareTo: z.string().optional(),
      clip: z.string().optional().describe("AnimSequence (same skeleton) to compare playback on both meshes."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const lines: string[] = [];
      if (a.exportMesh) {
        const e = await run("mesh_fbx_export(P['m'], P['f'])", { m: a.exportMesh, f: a.file });
        if (!e.ok) return text(`Export failed: ${e.error ?? "no file"}`, true);
        lines.push(`Exported ${a.exportMesh} -> ${a.file} (${e.bytes} bytes).`);
      }
      const dest = a.importAs.replace(/\/[^/]+$/, ""), name = a.importAs.split("/").pop();
      const im = await run("mesh_fbx_import(P['f'], P['d'], P['n'], P['s'], P['mat'])", { f: a.file, d: dest, n: name, s: a.skeleton ?? null, mat: a.materials ?? false });
      if (!im.ok) return text([...lines, `Import failed: ${im.error ?? "no skeletal mesh imported"}`].join("\n"), true);
      lines.push(`Imported ${im.mesh} (${(im.imported as string[]).join(", ")}).`);
      const ref = a.compareTo ?? a.exportMesh;
      let bad = 0;
      if (ref) {
        const c = await run("mesh_compare(P['a'], P['b'])", { a: ref, b: im.mesh });
        if (!c.ok) return text([...lines, `Compare failed: ${c.error}`].join("\n"), true);
        const v = c.verts as number[], bx = c.bounds_extent as number[][];
        const refWorst = Math.max(0, ...Object.values(c.ref_cm as Record<string, number>));
        const boundsGap = Math.max(...bx[0].map((x, i) => Math.abs(x - bx[1][i])));
        // CLAUDE-NOTE (live): Quinn re-imported with 45994 vertices for 45993 (a render vertex split at a seam) while
        // bounds, reference pose and clip playback were exact - vertex counts get a 0.1% tolerance.
        const vertOff = v[0] !== null && v[1] !== null ? Math.abs(v[0] - v[1]) / Math.max(1, v[0]) : 0;
        if (vertOff > 0.001 || refWorst > 0.1 || boundsGap > 0.5) bad++;
        lines.push(`Vs ${ref}: vertices ${v[0]} / ${v[1]}; bounds gap ${boundsGap.toFixed(2)} cm; reference pose worst ${refWorst} cm; bones ${(c.bones as number[]).join(" / ")} (skeleton ${c.skeleton_b})${(c.missing as string[]).length ? `; not in the import: ${(c.missing as string[]).slice(0, 5).join(", ")}...` : ""}`);
        if (a.clip) {
          try {
            const s1 = await run("take_subject('MCP_FbxA', P['c'], P['m'], (0, 10500, 0)) and take_subject('MCP_FbxB', P['c'], P['n'], (0, 10500, 0)) and rt_live_hold('MCP_FbxA', 'MCP_FbxB', P['c'], 0.5, P['n'])",
              { c: a.clip, m: ref, n: im.mesh });
            if (!s1.ok) throw new Error(s1.error);
            const cmp = await run("rt_live_compare('MCP_FbxA', 'MCP_FbxA', 'MCP_FbxB')", {});
            if (!cmp.ok) throw new Error(cmp.error);
            const w = Math.max(...Object.values(cmp.cm as Record<string, number>));
            if (w > 0.5) bad++;
            lines.push(`Clip ${a.clip.split("/").pop()} at 0.5 s on both meshes: worst bone ${w.toFixed(3)} cm${w > 0.5 ? "  <- POSES DIFFER" : ""}`);
          } finally {
            await run("remove_actor('MCP_FbxA')", {});
            await run("remove_actor('MCP_FbxB')", {});
          }
        }
      }
      return text([bad ? "MESH FBX CHECK FAILED:" : "Skeletal mesh FBX verified:", ...lines].join("\n"), bad > 0);
    },
  );
}
