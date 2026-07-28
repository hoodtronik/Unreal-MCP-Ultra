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

  // ============================================================
  // Rigged character profiles
  // ============================================================

  server.tool(
    "riot_register_character_profile",
    "Register a rigged character the crowd can be represented by, from PROJECT-OWNED asset paths. Nothing is hardcoded into the plugin — you supply the skeletal mesh, skeleton, animations and materials that already exist in your project. Every asset is loaded and inspected before the profile is stored: a path that merely parses is never treated as proof. Validation is all-or-nothing, so a rejected profile leaves nothing behind.",
    {
      profileId: z.string().describe("Stable id, max 64 chars, [A-Za-z0-9_-] only."),
      displayName: z.string().optional().describe("Human-readable name for reports."),
      skeletalMeshPath: z
        .string()
        .describe("Object path to a SkeletalMesh in your project, e.g. /Game/Characters/Manny/SKM_Manny.SKM_Manny"),
      skeletonPath: z
        .string()
        .optional()
        .describe("Skeleton path. Omit to derive it from the mesh (recorded as a warning)."),
      factionTypes: z
        .array(z.enum(["rioter", "police", "military", "neutral"]))
        .optional()
        .describe("Which faction types this character may represent. Omit or leave empty to accept any."),
      selectionWeight: z
        .number()
        .optional()
        .describe("Relative likelihood among eligible profiles. Must be > 0. Default 1."),
      animationMode: z
        .enum(["sequenceSet", "animationBlueprint"])
        .optional()
        .describe(
          "sequenceSet: Riot Crowd plays mapped Animation Sequences directly. animationBlueprint: your ABP reads RiotState/Speed/NormalizedSpeed/FactionType/SeedPhase/IsPromoted/IsMoving off the owning actor. Default sequenceSet."
        ),
      animationBlueprintPath: z
        .string()
        .optional()
        .describe("Required when animationMode is animationBlueprint. Asset path or generated-class path; both are accepted."),
      animationSet: z
        .array(
          z.object({
            slot: z
              .enum([
                "idle", "gathering", "advancing", "pressuring", "breaching", "panicked", "retreating",
                "holding", "bracing", "fallback", "broken", "inactive",
              ])
              .describe("Riot intent this animation covers. Rioter slots and defender slots are distinct."),
            animationPath: z.string().describe("Object path to an AnimSequence authored for this skeleton."),
            playRate: z.number().optional().describe("Base play rate. Per-agent variation multiplies this."),
            looping: z.boolean().optional().describe("Default true."),
            referenceSpeed: z
              .number()
              .optional()
              .describe(
                "Ground speed (uu/s) this clip was authored for. When set, playback rate scales with actual agent speed so feet track the ground. Leave unset for non-locomotion clips (attacks, idles, deaths)."
              ),
            minSpeed: z
              .number()
              .optional()
              .describe(
                "Minimum agent speed (uu/s) for this binding. Bind the same slot twice with different minSpeed to get a walk/run split: walk from 0, jog from ~280. Default 0."
              ),
          })
        )
        .optional()
        .describe(
          "Slot bindings. Only 'idle' and 'advancing' must resolve (plus 'holding' for defender-only profiles) — everything else falls back through a documented chain and is reported as a warning, so a walk+idle asset set is usable."
        ),
      materialOverrides: z
        .array(z.string())
        .optional()
        .describe("Material paths by mesh material-slot index. Empty strings leave that slot alone."),
      meshYawOffsetDegrees: z
        .number()
        .optional()
        .describe(
          "Yaw of the mesh relative to travel direction, degrees. Default -90, which is correct for Epic-convention meshes (Manny/Quinn are authored facing +Y). Set 0 for meshes authored facing +X."
        ),
      representationProfileId: z.string().optional().describe("Representation profile governing this character's LOD."),
      enabled: z.boolean().optional().describe("Default true. A disabled profile is never selected."),
      dryRun: z.boolean().optional().describe("Validate and report without storing anything."),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-register-character-profile", args);
      if (data.error) return text(renderProfileError(data));

      return text(renderMutation(data, renderProfileSummary(data.profile)));
    }
  );

  server.tool(
    "riot_update_character_profile",
    "Patch a registered character profile. Only the fields you pass change. The patch is validated on a copy and committed only if it passes, so a failed update leaves the previously working profile exactly as it was. Does NOT affect a crowd that is already spawned — a live crowd keeps the profiles it spawned with.",
    {
      profileId: z.string().describe("Profile to update."),
      displayName: z.string().optional(),
      skeletalMeshPath: z.string().optional(),
      skeletonPath: z.string().optional(),
      factionTypes: z.array(z.enum(["rioter", "police", "military", "neutral"])).optional(),
      selectionWeight: z.number().optional(),
      animationMode: z.enum(["sequenceSet", "animationBlueprint"]).optional(),
      animationBlueprintPath: z.string().optional(),
      animationSet: z
        .array(
          z.object({
            slot: z.enum([
              "idle", "gathering", "advancing", "pressuring", "breaching", "panicked", "retreating",
              "holding", "bracing", "fallback", "broken", "inactive",
            ]),
            animationPath: z.string(),
            playRate: z.number().optional(),
            looping: z.boolean().optional(),
            referenceSpeed: z.number().optional(),
            minSpeed: z.number().optional(),
          })
        )
        .optional()
        .describe("Replaces the whole animation set when supplied."),
      materialOverrides: z.array(z.string()).optional(),
      meshYawOffsetDegrees: z.number().optional(),
      representationProfileId: z.string().optional(),
      enabled: z.boolean().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-update-character-profile", args);
      if (data.error) return text(renderProfileError(data));

      const extra = renderProfileSummary(data.profile);
      if (data.affectsLiveCrowd === false) {
        extra.push("", "A spawned crowd is unaffected — riot_reset and riot_spawn to apply this.");
      }
      return text(renderMutation(data, extra));
    }
  );

  server.tool(
    "riot_delete_character_profile",
    "Delete a registered character profile. Refuses with RIOT_CHARACTER_PROFILE_IN_USE if any faction still references it, listing exactly which — silently unassigning it would change the look of scenarios you did not mention, and you would only find out at the next spawn. Pass force:true to delete it and drop those assignments.",
    {
      profileId: z.string().describe("Profile to delete."),
      force: z.boolean().optional().describe("Delete even if assigned, dropping the assignments."),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-delete-character-profile", args);
      if (data.error) {
        const lines = [renderError(data)];
        if (Array.isArray(data.usedBy) && data.usedBy.length > 0) {
          lines.push("", "Used by (scenario/faction):");
          for (const u of data.usedBy) lines.push(`  - ${u}`);
        }
        if (data.suggestedNextAction) lines.push("", `Next: ${data.suggestedNextAction}`);
        return text(lines.join("\n"));
      }

      return text(renderMutation(data));
    }
  );

  server.tool(
    "riot_list_character_profiles",
    "List every registered character profile with its validation state and weight, plus every registered representation profile. Use this to see what the crowd can actually be drawn with before spawning.",
    {},
    async () => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotGet("/api/riot-list-character-profiles");
      if (data.error) return text(renderError(data));

      const lines: string[] = [];
      lines.push(`Character profiles: ${data.count ?? 0} registered, ${data.usableCount ?? 0} usable`);
      for (const p of data.profiles ?? []) {
        const flag = p.enabled ? "" : "  (disabled)";
        lines.push(`  ${p.profileId}  [${p.validationState}]  weight ${p.selectionWeight}  ${p.animationMode}${flag}`);
        lines.push(`      mesh: ${p.skeletalMeshPath}`);
        if (p.warningCount > 0) lines.push(`      ${p.warningCount} warning(s) — riot_get_character_profile for detail`);
      }
      if ((data.count ?? 0) === 0) {
        lines.push("  (none — the crowd will fall back to placeholder shapes, which is diagnostic only)");
      }

      const reps = data.representationProfiles ?? [];
      lines.push("", `Representation profiles: ${reps.length}`);
      for (const r of reps) {
        lines.push(
          `  ${r.profileId}  near<${r.nearDistance} mid<${r.midDistance} far<${r.farDistance}  ` +
            `hysteresis ${r.hysteresisDistance}uu  budgets ${r.maxNearActors}/${r.maxMidRepresentations}`
        );
      }
      return text(lines.join("\n"));
    }
  );

  server.tool(
    "riot_get_character_profile",
    "Read one character profile back in full, including the resolved slot map — which animation every riot state will actually play, and which of those are reused via fallback rather than distinct assets. This is how you tell how much real animation variety a profile has.",
    { profileId: z.string() },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-get-character-profile", args);
      if (data.error) return text(renderProfileError(data));

      return text(renderProfileDetail(data));
    }
  );

  server.tool(
    "riot_validate_character_profile",
    "Validate a character profile WITHOUT spawning or storing anything. Pass a profileId to re-check a registered one, or pass the asset fields inline to check a candidate before committing it. Loads and inspects every asset and checks skeleton compatibility for the mesh and each animation — the failure this catches is an animation authored for a different rig, which loads perfectly and then plays as garbage.",
    {
      profileId: z.string().optional().describe("Registered profile to re-validate."),
      skeletalMeshPath: z.string().optional().describe("Supply asset fields to validate an unregistered candidate."),
      skeletonPath: z.string().optional(),
      factionTypes: z.array(z.enum(["rioter", "police", "military", "neutral"])).optional(),
      selectionWeight: z.number().optional(),
      animationMode: z.enum(["sequenceSet", "animationBlueprint"]).optional(),
      animationBlueprintPath: z.string().optional(),
      animationSet: z
        .array(
          z.object({
            slot: z.enum([
              "idle", "gathering", "advancing", "pressuring", "breaching", "panicked", "retreating",
              "holding", "bracing", "fallback", "broken", "inactive",
            ]),
            animationPath: z.string(),
            playRate: z.number().optional(),
            looping: z.boolean().optional(),
            referenceSpeed: z.number().optional(),
            minSpeed: z.number().optional(),
          })
        )
        .optional(),
      materialOverrides: z.array(z.string()).optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-validate-character-profile", args);
      if (data.error) return text(renderProfileError(data));

      const lines: string[] = [];
      lines.push(data.valid ? `VALID — ${data.validationState}` : `INVALID`);
      lines.push(data.summary ?? "");
      if (!data.valid && data.errorCode) lines.push(`  code: ${data.errorCode}`);
      lines.push("", ...renderProfileDetail(data).split("\n"));
      lines.push("", "Nothing was stored by this call.");
      return text(lines.join("\n"));
    }
  );

  server.tool(
    "riot_assign_character_profiles",
    "Assign character profiles to a faction in a scenario. Agents of that faction pick deterministically among them by selection weight, so the same scenario seed always produces the same character distribution. Every id is checked before any is written — a rejected call assigns nothing rather than a partial subset.",
    {
      scenarioId: z.string(),
      factionId: z.string(),
      profileIds: z
        .array(z.string())
        .describe("Registered, usable profile ids that accept this faction's type. Replaces any previous assignment."),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-assign-character-profiles", args);
      if (data.error) return text(renderProfileError(data));

      return text(renderMutation(data));
    }
  );

  // ============================================================
  // Representation
  // ============================================================

  server.tool(
    "riot_set_representation_profile",
    "Define the three representation tiers: distances, budgets, hysteresis, update rates and camera source. Tier 1 (0..near) is full skeletal actors, tier 2 (near..mid) is pooled skeletal with reduced animation cost, tier 3 (mid..far) is instanced. Only fields you pass change. Takes effect at the NEXT riot_spawn — a live crowd keeps the profile it spawned with.",
    {
      profileId: z.string().describe("Stable id for this representation profile."),
      scenarioId: z.string().optional().describe("Bind it to this scenario in the same call."),
      nearDistance: z.number().optional().describe("Tier 1 outer edge, uu. Default 2500."),
      midDistance: z.number().optional().describe("Tier 2 outer edge, uu. Default 7000."),
      farDistance: z.number().optional().describe("Beyond this nothing is drawn. Default 20000."),
      hysteresisDistance: z
        .number()
        .optional()
        .describe(
          "Band-edge dead zone in ABSOLUTE uu (default 500). Note the engine expresses hysteresis as a percentage of band distance; this is converted at apply time and the conversion is reported."
        ),
      maxNearActors: z.number().optional().describe("Tier 1 budget. Default 24. Overflow drops to tier 2, never deleted."),
      maxMidRepresentations: z.number().optional().describe("Tier 2 budget. Default 200."),
      farRepresentationEnabled: z.boolean().optional(),
      updateIntervals: z
        .object({
          near: z.number().optional(),
          mid: z.number().optional(),
          far: z.number().optional(),
        })
        .optional()
        .describe("Seconds between representation updates per tier. 0 = every frame."),
      cameraSource: z
        .enum(["piePlayerCamera", "explicitTransform", "sequencerCamera"])
        .optional()
        .describe("What LOD distance is measured from. piePlayerCamera is the default and needs no setup. sequencerCamera is NOT yet live-proven."),
      cameraTransform: z
        .object({
          x: z.number(), y: z.number(), z: z.number(),
          pitch: z.number().optional(), yaw: z.number().optional(), roll: z.number().optional(),
        })
        .optional()
        .describe("Used only when cameraSource is explicitTransform."),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-set-representation-profile", args);
      if (data.error) return text(renderProfileError(data));

      const extra: string[] = [];
      const r = data.representationProfile;
      if (r) {
        extra.push(
          `  tiers: near<${r.nearDistance}  mid<${r.midDistance}  far<${r.farDistance}  (uu)`,
          `  hysteresis: ${r.hysteresisDistance}uu   budgets: ${r.maxNearActors} near / ${r.maxMidRepresentations} mid`,
          `  camera: ${r.cameraSource}`
        );
      }
      if (data.appliesFrom) extra.push("", `Applies from: ${data.appliesFrom}`);
      return text(renderMutation(data, extra));
    }
  );

  server.tool(
    "riot_get_representation_report",
    "Read exactly how the live crowd is currently being drawn: counts per tier, how many agents QUALIFIED for each tier versus how many the budget allowed, pooled and active actor counts, duplicate-representation count, per-profile distribution, and which camera is driving LOD. Requires PIE. Unavailable measurements are reported as 'unavailable', never as zero.",
    {},
    async () => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-representation-report", {});
      if (data.error) return text(renderError(data));

      const lines: string[] = [];
      lines.push(`Representation report — scenario '${data.activeScenarioId ?? "(none)"}'`);
      lines.push(`  camera: ${data.cameraSource}`);
      if (typeof data.cameraTransform === "object" && data.cameraTransform !== null) {
        const c = data.cameraTransform;
        lines.push(`    at (${c.x?.toFixed?.(0)}, ${c.y?.toFixed?.(0)}, ${c.z?.toFixed?.(0)})`);
      } else if (data.cameraTransform) {
        lines.push(`    ${data.cameraTransform}`);
      }
      lines.push("");
      lines.push(`  agents: ${data.totalAgents}`);
      lines.push(`    near (skeletal):      ${data.nearTierCount}`);
      lines.push(`    mid  (skeletal, URO): ${data.midTierCount}`);
      lines.push(`    far  (instanced):     ${data.farTierCount}`);
      lines.push(`    placeholder fallback: ${data.fallbackPlaceholderCount}`);
      lines.push(`    not represented:      ${data.unrepresentedCount}`);
      lines.push("");
      const q = data.qualifiedCounts ?? {};
      const o = data.budgetOverflowCounts ?? {};
      lines.push(`  qualified vs represented:`);
      lines.push(`    near: ${q.near} qualified, ${data.nearTierCount} drawn, ${o.near} pushed to a cheaper tier`);
      lines.push(`    mid:  ${q.mid} qualified, ${data.midTierCount} drawn, ${o.mid} pushed to a cheaper tier`);
      lines.push("");
      lines.push(`  actors: ${data.activeSkeletalMeshCount} active skeletal, ${data.promotedActorCount} pinned, ${data.pooledActorCount} idle in pool`);
      lines.push(`  animated instances: ${data.animatedInstanceCount}`);
      lines.push(`  duplicate representations: ${data.duplicateRepresentationCount}${data.duplicateRepresentationCount > 0 ? "   <-- DEFECT" : ""}`);

      const byProfile = data.agentsByCharacterProfile ?? {};
      const keys = Object.keys(byProfile);
      if (keys.length > 0) {
        lines.push("", "  by character profile:");
        for (const k of keys) lines.push(`    ${k}: ${byProfile[k]}`);
      }

      if (Array.isArray(data.warnings) && data.warnings.length > 0) {
        lines.push("", "Warnings:");
        for (const w of data.warnings) lines.push(`  ! ${w}`);
      }
      return text(lines.join("\n"));
    }
  );

  server.tool(
    "riot_promote_agents",
    "Pin selected agents to the near tier (full skeletal) regardless of distance. Idempotent — promoting an already-promoted agent creates no second actor. Refuses as a WHOLE with RIOT_REPRESENTATION_BUDGET_EXCEEDED rather than partially applying if it would exceed maxNearActors. Requires PIE.",
    {
      agentIds: z.array(z.number()).optional().describe("Explicit agent ids from the representation report. Takes precedence over the filters below."),
      nearestToLocation: z
        .object({ x: z.number(), y: z.number(), z: z.number() })
        .optional()
        .describe("Select nearest to this world point. Defaults to nearest to the active camera."),
      factionType: z.enum(["rioter", "police", "military", "neutral"]).optional(),
      characterProfileId: z.string().optional(),
      maxCount: z.number().optional().describe("Cap on how many to select."),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-promote-agents", args);
      if (data.error) return text(renderProfileError(data));

      const extra: string[] = [];
      if (typeof data.alreadyPromoted === "number" && data.alreadyPromoted > 0) {
        extra.push(`  ${data.alreadyPromoted} were already promoted (no-op, not a failure).`);
      }
      if (Array.isArray(data.agentIds) && data.agentIds.length > 0) {
        extra.push(`  agent ids: ${data.agentIds.join(", ")}`);
      }
      return text(renderMutation(data, extra));
    }
  );

  server.tool(
    "riot_demote_agents",
    "Unpin agents so distance decides their tier again. Transform and riot state are preserved across the transition and no duplicate body is left behind. Idempotent — demoting an already-demoted agent is a no-op, never an error. Requires PIE.",
    {
      agentIds: z.array(z.number()).optional(),
      nearestToLocation: z.object({ x: z.number(), y: z.number(), z: z.number() }).optional(),
      factionType: z.enum(["rioter", "police", "military", "neutral"]).optional(),
      characterProfileId: z.string().optional(),
      maxCount: z.number().optional(),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const err = await preflight();
      if (err) return text(err);

      const data = await riotPost("/api/riot-demote-agents", args);
      if (data.error) return text(renderProfileError(data));

      const extra: string[] = [];
      if (typeof data.alreadyDemoted === "number" && data.alreadyDemoted > 0) {
        extra.push(`  ${data.alreadyDemoted} were already demoted (no-op, not a failure).`);
      }
      return text(renderMutation(data, extra));
    }
  );
}

// ============================================================
// Profile rendering helpers
//
// CLAUDE-NOTE: kept below registerRiotCrowdTools rather than beside the other helpers at the top of
// the file. They are specific to the character-profile tools and reference their response shape, and
// grouping them with the generic riotFetch/renderMutation helpers would imply they are usable by any
// riot tool, which they are not.
// ============================================================

/** Errors from the profile tools carry extra context the generic renderer would drop. */
function renderProfileError(data: RiotResponse): string {
  const lines = [renderError(data)];
  if (data.profileId) lines.push(`  profile: ${data.profileId}`);
  if (data.assetPath) lines.push(`  asset:   ${data.assetPath}`);
  if (data.partialMutation === true) {
    lines.push("  WARNING: this call partially applied. Read the state back before retrying.");
  } else if (data.partialMutation === false) {
    lines.push("  Nothing was changed.");
  }
  if (data.suggestedNextAction) lines.push("", `Next: ${data.suggestedNextAction}`);
  return lines.join("\n");
}

function renderProfileSummary(profile: any): string[] {
  if (!profile) return [];
  const lines: string[] = [];
  lines.push(`  validation: ${profile.validationState}`);
  lines.push(`  mesh:       ${profile.skeletalMeshPath}`);
  lines.push(`  skeleton:   ${profile.skeletonPath}`);
  const distinct = (profile.animationSet ?? []).length;
  lines.push(`  animations: ${distinct} bound`);
  if (Array.isArray(profile.warnings) && profile.warnings.length > 0) {
    lines.push(`  warnings:   ${profile.warnings.length} (riot_get_character_profile for detail)`);
  }
  return lines;
}

function renderProfileDetail(data: RiotResponse): string {
  const profile = data.profile ?? data;
  const lines: string[] = [];
  lines.push(`Character profile '${profile.profileId}'${profile.displayName ? ` — ${profile.displayName}` : ""}`);
  lines.push(`  validation:  ${profile.validationState}`);
  lines.push(`  enabled:     ${profile.enabled}`);
  lines.push(`  weight:      ${profile.selectionWeight}`);
  lines.push(`  factions:    ${(profile.factionTypes ?? []).join(", ") || "(any)"}`);
  lines.push(`  mesh:        ${profile.skeletalMeshPath}`);
  lines.push(`  skeleton:    ${profile.skeletonPath}`);
  lines.push(`  animMode:    ${profile.animationMode}`);
  if (profile.animationBlueprintPath) lines.push(`  animBP:      ${profile.animationBlueprintPath}`);

  const resolved = profile.resolvedAnimationSlots ?? [];
  if (resolved.length > 0) {
    const reused = resolved.filter((r: any) => r.usedFallback).length;
    const unresolved = resolved.filter((r: any) => r.resolvedSlot === "unresolved").length;
    lines.push("", `  resolved slots (${resolved.length - reused - unresolved} distinct, ${reused} reused, ${unresolved} unresolved):`);
    for (const r of resolved) {
      const mark = r.resolvedSlot === "unresolved" ? "  X" : r.usedFallback ? "  ~" : "   ";
      const target = r.usedFallback ? ` -> ${r.resolvedSlot}` : "";
      lines.push(`  ${mark} ${r.slot}${target}${r.animationPath ? `   ${r.animationPath}` : ""}`);
    }
    lines.push("      (~ = reusing another slot's animation, X = nothing to play)");
  }

  if (profile.failureCode) {
    lines.push("", `  FAILURE [${profile.failureCode}]: ${profile.failureMessage}`);
  }
  if (Array.isArray(profile.warnings) && profile.warnings.length > 0) {
    lines.push("", "  Warnings:");
    for (const w of profile.warnings) lines.push(`    ! ${w}`);
  }
  return lines.join("\n");
}
