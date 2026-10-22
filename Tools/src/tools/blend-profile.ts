import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

// CLAUDE-NOTE (2026-10-22): Python can only read blend profiles (Skeleton.get_blend_profile); C++
// /api/set-blend-profile creates/updates one with per-bone scales (recursing to children), for transition blend
// profiles (TimeFactor / WeightFactor) and for LayeredBoneBlend masks (BlendMask). Verified by probing the scales back.

export function registerBlendProfileTools(server: McpServer): void {
  server.tool(
    "set_blend_profile",
    "Create or update a skeleton BLEND PROFILE / BLEND MASK: per-bone scales (applied to the bone's children too unless " +
      "recurse=false). mode BlendMask (for LayeredBoneBlend in Blend Mask mode: 1 = take the layer, 0 = keep the base), " +
      "TimeFactor or WeightFactor (state-machine transition profiles). Scales are read back for each listed bone and `probe` bones.",
    {
      skeleton: z.string(),
      name: z.string(),
      mode: z.enum(["BlendMask", "TimeFactor", "WeightFactor"]).optional(),
      bones: z.array(z.object({ bone: z.string(), scale: z.number(), recurse: z.boolean().optional() }).strict()).optional(),
      remove: z.boolean().optional().describe("Delete the named profile from the skeleton instead."),
      clear: z.boolean().optional().describe("Remove existing entries first."),
      probe: z.array(z.string()).optional().describe("Extra bones (e.g. children) to read back."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }], isError: true };
      if (a.remove) {
        const r = await uePost("/api/set-blend-profile", { skeleton: a.skeleton, name: a.name, remove: true });
        if (r.error) return { content: [{ type: "text" as const, text: `Error: ${r.error}` }], isError: true };
        return { content: [{ type: "text" as const, text: `${r.removed ? "Removed" : "NOT removed"} '${a.name}' from ${a.skeleton} (saved ${r.saved}).` }], ...(r.removed ? {} : { isError: true }) };
      }
      if (!a.bones?.length) return { content: [{ type: "text" as const, text: "bones is required (or remove: true)" }], isError: true };
      const bones = a.bones;
      const probe = [...bones.map((b) => b.bone), ...(a.probe ?? [])];
      const d = await uePost("/api/set-blend-profile", { skeleton: a.skeleton, name: a.name, mode: a.mode ?? "BlendMask", bones, clear: a.clear ?? false, probe });
      if (d.error) return { content: [{ type: "text" as const, text: `Error: ${d.error}` }], isError: true };
      const got = d.probe as Record<string, number>;
      const bad = bones.filter((b) => Math.abs((got[b.bone] ?? -1) - b.scale) > 1e-4);
      const lines = [`${d.created ? "Created" : "Updated"} ${d.profile} (${d.mode}, ${d.entries} entries, saved ${d.saved}).`,
        `Read back: ${Object.entries(got).map(([k, v]) => `${k} ${v}`).join(", ")}`];
      if (bad.length) lines.unshift(`BLEND PROFILE CHECK FAILED: ${bad.map((b) => b.bone).join(", ")} not at the asked scale`);
      return { content: [{ type: "text" as const, text: lines.join("\n") }], ...(bad.length ? { isError: true } : {}) };
    },
  );
}
