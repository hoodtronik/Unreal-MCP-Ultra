import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-22, live 5.6.1): bindings + FBX (Tools/python/ue_bind.py). Possess = add_possessable on a level
// actor; rebind = LevelSequenceEditorSubsystem.replace_binding_with_actors(actors, binding) which acts on the OPEN
// sequence (2 args, not 3). Live: Box possessed BindCubeA (keyed to y -700), rebound to BindCubeB -> B at the keys, A
// restored to its own place. FBX: SequencerTools.export_level_sequence_fbx / import_level_sequence_fbx
// (MovieSceneUserImportFBXSettings match_by_name_only): SEQ_Follow's keyed Pan camera exported and imported onto a
// same-named camera in a new sequence matched at 0.000 on every compared frame (294 transform keys).

const LIBS = ["ue_posing.py", "ue_shot.py", "ue_bind.py"];

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}
async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

async function xformAt(seq: string, binding: string, f: number): Promise<PoseResult> {
  await run("scrub(P['s'], P['f'])", { s: seq, f });
  await run("scrub(P['s'], P['f'])", { s: seq, f });
  return run("actor_xform(P['s'], P['b'])", { s: seq, b: binding });
}

export function registerSeqBindTools(server: McpServer): void {
  server.tool(
    "seq_bind",
    "Sequence BINDINGS: 'possess' binds an existing level actor (by label) into a sequence (so its tracks animate the " +
      "real actor), 'rebind' points an existing binding at other level actor(s) - its tracks then drive them - and " +
      "'list' shows each binding, its live actor, spawnable or possessable, and its tracks. Verified from the live " +
      "bound actors.",
    {
      sequence: z.string(),
      action: z.enum(["possess", "rebind", "list"]),
      actor: z.string().optional().describe("possess: level actor label."),
      binding: z.string().optional().describe("possess: binding name to give it; rebind: binding to repoint."),
      actors: z.array(z.string()).optional().describe("rebind: level actor label(s)."),
      createSequence: z.boolean().optional().describe("Create the sequence if missing (default false)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.createSequence) {
        const c = await run("load_sequence(P['s'], open_it=True, create=True) and {'ok': True}", { s: a.sequence });
        if (!c.ok) return text(`Error: ${c.error}`, true);
      }
      if (a.action === "possess") {
        if (!a.actor) return text("Error: possess needs actor.", true);
        const r = await run("bind_possess(P['s'], P['a'], P['n'])", { s: a.sequence, a: a.actor, n: a.binding ?? null });
        if (!r.ok) return text(`Error: ${r.error}`, true);
      } else if (a.action === "rebind") {
        if (!a.binding || !a.actors?.length) return text("Error: rebind needs binding and actors.", true);
        const r = await run("bind_rebind(P['s'], P['b'], P['a'])", { s: a.sequence, b: a.binding, a: a.actors });
        if (!r.ok) return text(`Error: ${r.error}`, true);
      }
      const l = await run("bind_list(P['s'])", { s: a.sequence });
      if (!l.ok) return text(`Error: ${l.error}`, true);
      const rows = l.bindings as any[];
      let bad = false;
      if (a.action === "possess") bad = !rows.some((b) => b.actor === a.actor);
      if (a.action === "rebind") bad = !rows.some((b) => b.binding === a.binding && a.actors!.includes(b.actor));
      const lines = rows.map((b) => `  ${b.binding}: ${b.spawnable ? "spawnable" : "possessable"} -> ${b.actor ?? "(nothing live)"}; tracks ${b.tracks.join(", ") || "none"}`);
      return text([`${bad ? "BINDING CHECK FAILED" : a.action === "list" ? "Bindings" : "Verified"} (${a.sequence}):`, ...lines].join("\n"), bad);
    },
  );

  server.tool(
    "seq_fbx",
    "FBX in/out for sequence bindings (cameras, actors - e.g. to/from Blender or Maya): 'export' writes the given " +
      "bindings' animation to an .fbx; 'import' applies an .fbx onto same-named bindings (match by name, transform " +
      "track replaced). With compareWith (another sequence + binding names) the imported motion is checked frame by " +
      "frame against the original.",
    {
      action: z.enum(["export", "import"]),
      sequence: z.string(),
      bindings: z.array(z.string()).min(1),
      file: z.string().describe("Absolute .fbx path."),
      compareWith: z.string().optional().describe("import: source sequence to compare against (same binding names)."),
      frames: z.array(z.number().int()).optional().describe("Frames to compare (default 0, 6, 12, 18, 23)."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      if (a.action === "export") {
        const r = await run("fbx_export(P['s'], P['b'], P['f'])", { s: a.sequence, b: a.bindings, f: a.file });
        return r.ok ? text(`Exported ${a.bindings.join(", ")} from ${a.sequence} to ${a.file} (${r.bytes} bytes).`) : text(`Error: ${r.error ?? "export failed"}`, true);
      }
      const r = await run("fbx_import(P['s'], P['b'], P['f'])", { s: a.sequence, b: a.bindings, f: a.file });
      if (!r.ok) return text(`Error: ${r.error ?? "import failed"}`, true);
      const lines = [`Imported ${a.file} onto ${a.bindings.join(", ")} in ${a.sequence} (${r.transform_keys} transform keys).`];
      if (!a.compareWith) return text(lines.join("\n"), !(r.transform_keys > 0));
      let worst = 0, worstR = 0;
      for (const b of a.bindings) {
        for (const f of a.frames ?? [0, 6, 12, 18, 23]) {
          const s0 = await xformAt(a.compareWith, b, f);
          const s1 = await xformAt(a.sequence, b, f);
          if (!s0.ok || !s1.ok) return text(`Error comparing ${b}@${f}: ${s0.error ?? s1.error}`, true);
          const d = Math.hypot(...(s0.loc as number[]).map((v, i) => v - (s1.loc as number[])[i]));
          const dr = Math.max(...(s0.rot as number[]).map((v, i) => Math.abs((((v - (s1.rot as number[])[i]) % 360) + 540) % 360 - 180)));
          worst = Math.max(worst, d); worstR = Math.max(worstR, dr);
          lines.push(`  ${b} f${f}: ${d.toFixed(3)} cm / ${dr.toFixed(3)} deg from ${a.compareWith}`);
        }
      }
      const ok = worst <= 0.5 && worstR <= 0.5;
      return text([`${ok ? "Round trip verified" : "ROUND TRIP DIFFERS"}: worst ${worst.toFixed(3)} cm / ${worstR.toFixed(3)} deg.`, ...lines].join("\n"), !ok);
    },
  );
}
