import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, UE_BASE_URL } from "../ue-bridge.js";

// CLAUDE-NOTE: Riot Crowd tools talk to the OPTIONAL BlueprintMCPRiotCrowd plugin, which installs
// as a sibling of BlueprintMCP and is absent by default. That makes these tools different from
// every other tool file here in one important way: their routes may legitimately not exist.
//
// The shared uePost() calls resp.json() unconditionally, so a 404 from an uninstalled feature would
// surface as an opaque JSON parse error. These helpers check the status first and translate a 404
// into RIOT_FEATURE_NOT_INSTALLED with actionable install instructions, which is the difference
// between "this tool is broken" and "you have not installed this yet".

const INSTALL_HINT =
  "The Riot Crowd feature is not installed.\n\n" +
  "It ships inside the BlueprintMCP repo at RiotCrowd/ but is INERT while nested there — Unreal's " +
  "plugin scanner stops descending once it finds a .uplugin, so a nested plugin is never " +
  "discovered. To enable it, install it as a SIBLING:\n\n" +
  "  <Project>/Plugins/BlueprintMCPRiotCrowd/   <-- copy or junction RiotCrowd/ here\n\n" +
  "Then enable the MassGameplay plugin in your .uproject and restart the editor.";

interface RiotResponse {
  [key: string]: any;
  error?: string;
  errorCode?: string;
}

async function riotFetch(endpoint: string, init?: RequestInit): Promise<RiotResponse> {
  let resp: Response;
  try {
    resp = await fetch(`${UE_BASE_URL}${endpoint}`, {
      signal: AbortSignal.timeout(300000),
      ...init,
    });
  } catch (e) {
    return { error: `Could not reach the UE server: ${e}`, errorCode: "RIOT_OPERATION_FAILED" };
  }

  if (resp.status === 404) {
    return { error: INSTALL_HINT, errorCode: "RIOT_FEATURE_NOT_INSTALLED" };
  }

  try {
    return (await resp.json()) as RiotResponse;
  } catch {
    return {
      error: `The server returned a non-JSON response (HTTP ${resp.status}).`,
      errorCode: "RIOT_OPERATION_FAILED",
    };
  }
}

const riotGet = (endpoint: string) => riotFetch(endpoint);

const riotPost = (endpoint: string, body: Record<string, any>) =>
  riotFetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Uniform text result. */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

/** Standard error rendering: always surface the machine-checkable code alongside the message. */
function renderError(data: RiotResponse): string {
  return data.errorCode ? `Error [${data.errorCode}]: ${data.error}` : `Error: ${data.error}`;
}

/** Every riot tool starts the same way; returns an error string or null. */
async function preflight(): Promise<string | null> {
  return await ensureUE();
}

function renderMutation(data: RiotResponse, extraLines: string[] = []): string {
  const lines: string[] = [];
  if (data.dryRun) lines.push("DRY RUN — nothing was changed.");
  lines.push(data.summary ?? "Done.");
  lines.push(...extraLines);

  if (Array.isArray(data.warnings) && data.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const w of data.warnings) lines.push(`  ! ${w}`);
  }
  if (Array.isArray(data.nextSteps) && data.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    data.nextSteps.forEach((s: string, i: number) => lines.push(`  ${i + 1}. ${s}`));
  }
  return lines.join("\n");
}

const vec3 = z.object({
  x: z.number().describe("X coordinate"),
  y: z.number().describe("Y coordinate"),
  z: z.number().describe("Z coordinate"),
});

export function registerRiotCrowdTools(server: McpServer): void {
  // ============================================================
  // Capability + inspection
  // ============================================================

  server.tool(
    "riot_get_capabilities",
    "Report whether the optional Riot Crowd feature is installed and what it can actually do in this editor: engine version, which Mass plugins are enabled, and which capabilities are supported vs explicitly unsupported. Call this FIRST — it is the only riot tool that is meaningful when the feature is missing.",
    {},
    async () => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotGet("/api/riot-capabilities");
      if (data.error) {
        // A 404 here is the definitive "not installed" answer, not a failure.
        if (data.errorCode === "RIOT_FEATURE_NOT_INSTALLED") {
          return text(`featureInstalled: false\nsupported: false\n\n${data.error}`);
        }
        return text(renderError(data));
      }

      const lines: string[] = [];
      lines.push(`Riot Crowd capabilities`);
      lines.push(`  featureInstalled: ${data.featureInstalled}`);
      lines.push(`  supported:        ${data.supported}`);
      lines.push(`  engineVersion:    ${data.engineVersion}`);
      lines.push("");
      lines.push(`Plugins:`);
      for (const [name, enabled] of Object.entries(data.availablePlugins ?? {})) {
        const required = (data.requiredPlugins ?? {})[name] !== undefined;
        lines.push(`  ${enabled ? "on " : "off"} ${name}${required ? "  (required)" : ""}`);
      }
      lines.push("");
      lines.push(`Supported:`);
      for (const key of Object.keys(data).filter((k) => k.startsWith("supports"))) {
        lines.push(`  ${data[key] ? "yes" : "NO "} ${key.replace(/^supports/, "")}`);
      }
      lines.push(`  ${data.deterministicSeed ? "yes" : "NO "} DeterministicSeed`);

      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        lines.push("", "Warnings:");
        for (const w of data.warnings) lines.push(`  ! ${w}`);
      }
      return text(lines.join("\n"));
    }
  );

  server.tool(
    "riot_list_scenarios",
    "List every riot scenario currently defined, with its lifecycle state, seed, and element counts.",
    {},
    async () => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotGet("/api/riot-list-scenarios");
      if (data.error) return text(renderError(data));

      if (!data.count) return text("No riot scenarios defined. Use riot_create_scenario to make one.");

      const lines = [`${data.count} scenario(s):`];
      for (const s of data.scenarios) {
        lines.push(
          `  ${s.scenarioId} — "${s.displayName}" [${s.lifecycle}] seed=${s.seed} ` +
          `factions=${s.factionCount} origins=${s.flowOriginCount} blockades=${s.blockadeCount} triggers=${s.triggerCount}`
        );
      }
      return text(lines.join("\n"));
    }
  );

  server.tool(
    "riot_get_scenario",
    "Read back a scenario's full definition and current lifecycle state.",
    { scenarioId: z.string().describe("Stable scenario id") },
    async ({ scenarioId }) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-get-scenario", { scenarioId });
      if (data.error) return text(renderError(data));
      return text(JSON.stringify(data.scenario, null, 2));
    }
  );

  server.tool(
    "riot_get_runtime_report",
    "Get the live simulation state: per-state agent counts, per-blockade pressure against its hold/break thresholds, trigger fire times, and the pressure model's tunables plus its formula so every number is reproducible by hand. Requires PIE to be running.",
    {},
    async () => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-runtime-report", {});
      if (data.error) return text(renderError(data));

      const c = data.agentCounts ?? {};
      const lines: string[] = [];
      lines.push(`Riot runtime report — scenario '${data.scenarioId}' [${data.lifecycle}]`);
      lines.push(`  running=${data.running} spawned=${data.spawned} t=${(data.simulationTime ?? 0).toFixed(2)}s seed=${data.seed}`);
      lines.push("");
      lines.push(`Agents (${c.total ?? 0} rioters, ${c.defenders ?? 0} defenders):`);
      for (const k of ["queued", "advancing", "blocked", "pressuring", "breaching", "passedBlockade", "panicked", "retreating", "inactive"]) {
        if (c[k]) lines.push(`  ${k.padEnd(15)} ${c[k]}`);
      }
      lines.push(`  ${"passed total".padEnd(15)} ${data.agentsPassedBlockade ?? 0}`);

      lines.push("", "Blockades:");
      for (const b of data.blockades ?? []) {
        lines.push(
          `  ${b.blockadeId}: pressure ${b.currentPressure.toFixed(1)} (peak ${b.peakPressure.toFixed(1)}) ` +
          `hold=${b.holdThreshold} break=${b.breakThreshold} defenders=${b.defenderCount} ` +
          `${b.broken ? `BROKEN at t=${b.brokenAtTime.toFixed(2)}s` : "holding"}`
        );
      }

      const triggers = data.triggers ?? [];
      if (triggers.length) {
        lines.push("", "Triggers:");
        for (const t of triggers) {
          lines.push(`  ${t.triggerId}: ${t.fired ? `fired at t=${t.firedAtTime.toFixed(2)}s` : "pending"}`);
        }
      }

      const m = data.pressureModel;
      if (m) {
        lines.push("", "Pressure model:");
        lines.push(`  ${m.formula}`);
        lines.push(
          `  pressureGain=${m.pressureGain} sustainBonusPerSecond=${m.sustainBonusPerSecond} ` +
          `decayRatePerSecond=${m.decayRatePerSecond} riseRatePerSecond=${m.riseRatePerSecond} ` +
          `contactBand=${m.contactBand} maxPressure=${m.maxPressure}`
        );
      }
      return text(lines.join("\n"));
    }
  );

  // ============================================================
  // Scenario authoring
  // ============================================================

  server.tool(
    "riot_create_scenario",
    "Create a new riot scenario. The seed makes runs reproducible: the same seed with the same definition produces the same broad outcome. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable id, 1-64 chars of [A-Za-z0-9_-]"),
      displayName: z.string().optional().describe("Human-readable name (defaults to scenarioId)"),
      seed: z.number().int().optional().describe("Deterministic seed (default 1337)"),
      world: z.string().optional().describe("Level name this scenario is authored against"),
      pressureModel: z.object({
        pressureGain: z.number().optional().describe("Pressure units per attacker-per-defender (default 25)"),
        sustainBonusPerSecond: z.number().optional().describe("Extra fraction per second of sustained pressing (default 0.15)"),
        decayRatePerSecond: z.number().optional().describe("Pressure shed per second when nobody presses (default 20)"),
        riseRatePerSecond: z.number().optional().describe("How fast pressure chases its target (default 60)"),
        contactBand: z.number().optional().describe("Distance within which an agent counts as pressing (default 250)"),
        maxPressure: z.number().optional().describe("Hard ceiling (default 500)"),
      }).optional().describe("Override the pressure model tunables"),
      dryRun: z.boolean().optional().describe("Validate without creating"),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-create-scenario", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_delete_scenario",
    "Delete a scenario. If it is currently spawned, its runtime state is reset first so no agents are stranded. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      dryRun: z.boolean().optional().describe("Report what would be deleted without deleting"),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-delete-scenario", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_add_faction",
    "Add a faction to a scenario. A vertical slice needs at least two: one rioter faction and one defending (police/military) faction. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      factionId: z.string().describe("Stable faction id"),
      displayName: z.string().optional().describe("Human-readable name"),
      type: z.enum(["rioter", "police", "military", "neutral"]).optional().describe("Faction type (default rioter)"),
      maxSpawnCount: z.number().int().optional().describe("Upper bound on agents of this faction"),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-add-faction", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_add_flow_origin",
    "Add an entry point that releases rioters into the scene. Use three or more from different directions to get streams converging on a blockade. spawnDelay and spawnInterval stagger the release so the crowd does not appear as one synchronized block. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      originId: z.string().describe("Stable origin id"),
      factionId: z.string().describe("Which faction spawns here — must already exist"),
      location: vec3.describe("World position of the entry point"),
      initialTarget: vec3.optional().describe("Where agents head first (defaults to the origin location)"),
      spawnRadius: z.number().optional().describe("Scatter radius around location (default 0 = exact point)"),
      spawnCount: z.number().int().describe("How many agents this origin releases"),
      spawnDelay: z.number().optional().describe("Seconds before the first agent is released"),
      spawnInterval: z.number().optional().describe("Seconds between agents (0 = all at once)"),
      speedMin: z.number().optional().describe("Minimum movement speed (default 200)"),
      speedMax: z.number().optional().describe("Maximum movement speed (default 400)"),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-add-flow-origin", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_add_blockade",
    "Add a defended blockade segment. Pressure builds as rioters press it; it breaks when pressure reaches breakThreshold. breakThreshold MUST exceed holdThreshold or the call is rejected — otherwise the segment would break the instant any pressure registers and the scenario could never demonstrate holding. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      blockadeId: z.string().describe("Stable blockade id"),
      defendingFactionId: z.string().describe("Which faction defends here — must already exist"),
      location: vec3.describe("Centre of the blockade line"),
      yawDegrees: z.number().optional().describe("Facing, degrees. The line runs perpendicular to this."),
      width: z.number().optional().describe("Length of the line (default 800)"),
      depth: z.number().optional().describe("How far past the line counts as through (default 200)"),
      defenderCount: z.number().int().describe("Defenders placed along the segment — the pressure denominator"),
      holdThreshold: z.number().optional().describe("Pressure at which the line is straining but holding (default 40)"),
      breakThreshold: z.number().optional().describe("Pressure at which it breaks (default 100)"),
      fallbackLocation: vec3.optional().describe("Where defenders withdraw to once broken"),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-add-blockade", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_add_hotspot",
    "Add a marked zone of interest (pressure, breach, or panic). Hotspots are annotations for the director and become active when a trigger of the same type fires. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      hotspotId: z.string().describe("Stable hotspot id"),
      type: z.enum(["pressure", "breach", "panic"]).optional().describe("Hotspot kind (default pressure)"),
      location: vec3.describe("World position"),
      influenceRadius: z.number().optional().describe("Radius of influence (default 500)"),
      intensity: z.number().optional().describe("Relative intensity (default 1.0)"),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-add-hotspot", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_set_trigger",
    "Define a breach or panic trigger. Calling this again with the same triggerId REPLACES it rather than adding a duplicate. A breach trigger forces a blockade open; a panic trigger sends a fraction of the crowd into retreat. Supports dryRun.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      triggerId: z.string().describe("Stable trigger id"),
      type: z.enum(["breach", "panic"]).describe("What the trigger does"),
      condition: z.enum(["pressure_threshold", "elapsed_time", "agents_passed"]).optional()
        .describe("What fires it (default pressure_threshold)"),
      targetBlockadeId: z.string().optional()
        .describe("For breach: which blockade opens. Omit to pick the most-pressured one."),
      thresholdValue: z.number().describe("Pressure, seconds, or agent count depending on condition"),
      affectedFraction: z.number().optional()
        .describe("For panic: fraction of the live crowd that panics, in (0,1]. Default 0.5"),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);
      const data = await riotPost("/api/riot-set-trigger", args);
      if (data.error) return text(renderError(data));
      return text(renderMutation(data));
    }
  );

  // ============================================================
  // Runtime control
  // ============================================================

  server.tool(
    "riot_spawn",
    "Instantiate a scenario's agents as Mass entities in the running PIE world. Requires PIE (start_pie first) because Mass processors only execute in a game world. With dryRun it reports the counts it WOULD create and creates nothing. Counts are read back off live entities, so a mismatch against the plan is reported as a warning rather than hidden.",
    {
      scenarioId: z.string().describe("Stable scenario id"),
      dryRun: z.boolean().optional().describe("Report planned counts without creating anything"),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-spawn", args);
      if (data.error) return text(renderError(data));

      return text(renderMutation(data, [
        `  planned:  ${data.plannedRioters} rioters, ${data.plannedDefenders} defenders`,
        `  spawned:  ${data.spawnedRioters} rioters, ${data.spawnedDefenders} defenders`,
      ]));
    }
  );

  const lifecycleTool = (
    name: string,
    endpoint: string,
    description: string
  ) => {
    server.tool(name, description, {}, async () => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost(endpoint, {});
      if (data.error) return text(renderError(data));

      return text(renderMutation(data, [
        `  running=${data.running} spawned=${data.spawned} ` +
        `liveAgents=${data.liveAgents} liveDefenders=${data.liveDefenders}`,
      ]));
    });
  };

  lifecycleTool(
    "riot_start",
    "/api/riot-start",
    "Begin advancing a spawned riot simulation. Reports the live agent counts read back after starting."
  );

  lifecycleTool(
    "riot_pause",
    "/api/riot-pause",
    "Pause the simulation. Agent state stops advancing; the crowd stays rendered where it is."
  );

  lifecycleTool(
    "riot_resume",
    "/api/riot-resume",
    "Resume a paused simulation from exactly where it stopped."
  );

  lifecycleTool(
    "riot_reset",
    "/api/riot-reset",
    "Destroy every agent and actor the scenario created and zero its runtime counters, leaving the authored definition intact so the same seed can be re-run and compared. Idempotent — calling it twice is safe. Reports success=false with RIOT_RESET_FAILED if any agent survives."
  );
}
