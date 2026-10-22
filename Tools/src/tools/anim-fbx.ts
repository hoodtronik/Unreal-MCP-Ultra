import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): skeletal animation FBX out / in (Tools/python/ue_animfbx.py; AssetExportTask +
// AnimSequenceExporterFBX, AssetImportTask + FbxImportUI FBXIT_ANIMATION onto an existing skeleton). A clip authored
// on the target skeleton (A_LookAround) round-trips at 0.000 cm on every bone. A clip whose retarget source is another
// mesh (MF_Unarmed_Walk_Fwd, authored on SKM_Quinn) comes back up to 4.4 cm off (pelvis 2.7 cm) - copying the retarget
// source made it worse (5.3 cm, double retarget), unresolved - so the tool warns. FBX also drops root-motion flags and
// sync markers: restoreMeta copies them (and notifies) from the source.

const LIBS = ["ue_posing.py", "ue_anim.py", "ue_animfbx.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

export function registerAnimFbxTools(server: McpServer): void {
  server.tool(
    "anim_fbx",
    "Skeletal ANIMATION FBX in/out (to/from Blender, Maya, mocap): 'export' writes an AnimSequence to .fbx; 'import' " +
      "brings an .fbx animation onto an existing skeleton as a new clip. With compareWith (the original clip) the import " +
      "is checked bone by bone at sampled times, and Unreal-only metadata FBX drops (root motion flags, sync markers, " +
      "notifies) is copied back from it.",
    {
      action: z.enum(["export", "import"]),
      clip: z.string().optional().describe("export: the AnimSequence."),
      file: z.string().describe("Absolute .fbx path."),
      dest: z.string().optional().describe("import: destination folder, e.g. /Game/Anims/Imported."),
      name: z.string().optional().describe("import: new clip name."),
      skeleton: z.string().optional().describe("import: target skeleton path."),
      compareWith: z.string().optional().describe("import: original clip to verify against (and copy metadata from)."),
      restoreMeta: z.boolean().optional().describe("import: copy root motion / markers / notifies from compareWith (default true)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.action === "export") {
        if (!a.clip) return text("Error: export needs clip.", true);
        const r = await run("anim_fbx_export(P['c'], P['f'])", { c: a.clip, f: a.file });
        return r.ok ? text(`Exported ${a.clip} to ${a.file} (${r.bytes} bytes).`) : text(`Error: export failed ${JSON.stringify(r.errors ?? r.error)}`, true);
      }
      if (!a.dest || !a.name || !a.skeleton) return text("Error: import needs dest, name and skeleton.", true);
      const r = await run("anim_fbx_import(P['f'], P['d'], P['n'], P['s'])", { f: a.file, d: a.dest, n: a.name, s: a.skeleton });
      if (!r.ok) return text(`Error: import produced no AnimSequence (${JSON.stringify(r.imported ?? r.error)})`, true);
      const lines = [`Imported ${a.file} -> ${r.anim}.`];
      if (!a.compareWith) return text(lines.join("\n"));
      if (a.restoreMeta ?? true) {
        const m = await run("anim_restore_meta(P['s'], P['d'])", { s: a.compareWith, d: r.anim });
        if (m.ok) lines.push(`  metadata from the source: root motion ${m.root_motion ? "ON" : "off"}, ${m.markers.length} sync marker(s), ${m.notifies} notify(s).`);
      }
      const info = await run("{'ok': True, 'len': unreal.load_asset(P['c']).get_play_length(), 'rs': str(unreal.load_asset(P['c']).get_editor_property('retarget_source'))}", { c: a.compareWith });
      const L = info.ok ? (info.len as number) : 1;
      const times = [0, 0.25, 0.5, 0.75, 1].map((k) => +(k * L * 0.999).toFixed(3));
      const c = await run("anim_compare(P['a'], P['b'], P['t'])", { a: a.compareWith, b: r.anim, t: times });
      if (!c.ok) return text(`${lines.join("\n")}\nCompare failed: ${c.error}`, true);
      const ok = c.worst <= 0.5 && c.lengths[0] === c.lengths[1];
      lines.push(`  ${ok ? "Round trip verified" : "ROUND TRIP DIFFERS"}: worst bone ${c.worst} cm (${c.bone} @${c.at}s); per time ${JSON.stringify(c.per_time)}; lengths ${JSON.stringify(c.lengths)}.`);
      if (!ok && info.ok && info.rs && info.rs !== "None")
        lines.push(`  Note: the source clip retargets from '${info.rs}' (authored on another mesh) - FBX carries its raw proportions; measured up to 4.4 cm on the Quinn-authored walk.`);
      return text(lines.join("\n"), !ok);
    },
  );
}
