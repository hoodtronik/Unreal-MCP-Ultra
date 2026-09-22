import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Skill } from "./types.js";
import { pcgSkill } from "./pcg.js";
import { blueprintsSkill } from "./blueprints.js";
import { levelsSkill } from "./levels.js";
import { materialsSkill } from "./materials.js";
import { animEditingSkill } from "./anim-editing.js";
import { skySkill } from "./sky.js";
import { niagaraSkill } from "./niagara.js";
import { groomSkill } from "./groom.js";
import { mirrorTablesSkill } from "./mirror-tables.js";
import { previzSequencerSkill } from "./previz-sequencer.js";

// CLAUDE-NOTE: Skills system. Each skill is exposed as an MCP Resource at
// skill://unreal/{name}. Registering via server.resource() automatically wires the
// resources/list and resources/read MCP handlers (the high-level SDK does this), so the
// agent can discover skills (list_skills tool or resources/list) and pull a skill's full
// instructions on demand (resources/read). Pure transport-layer — UE 5.6 safe.

export const SKILLS: Skill[] = [
  pcgSkill, blueprintsSkill, levelsSkill, materialsSkill, animEditingSkill, skySkill,
  niagaraSkill, groomSkill, mirrorTablesSkill, previzSequencerSkill,
];

const SKILL_URI = (name: string) => `skill://unreal/${name}`;

export function registerSkills(server: McpServer): void {
  for (const skill of SKILLS) {
    server.resource(
      `skill-${skill.name}`,
      SKILL_URI(skill.name),
      { description: skill.description, mimeType: "text/markdown" },
      async (uri) => ({
        contents: [{ uri: uri.href, text: skill.content, mimeType: "text/markdown" }],
      })
    );
  }

  server.tool(
    "list_skills",
    "List available Unreal skills — named instruction sets that tell you HOW to approach a class of task (PCG spatial reasoning, safe Blueprint editing, level placement, material editing). Call this before a complex task, then retrieve a skill's full guidance via the resource URI (resources/read on skill://unreal/{name}).",
    {},
    async () => {
      const lines = ["Available skills (retrieve via resources/read on the URI):", ""];
      for (const s of SKILLS) {
        lines.push(`  ${s.name}  —  ${s.description}`);
        lines.push(`      ${SKILL_URI(s.name)}`);
      }
      lines.push("", "Tip: read the relevant skill before starting, then follow its workflow with the matching tools.");
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    }
  );
}
