import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";

const vec3 = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  z: z.number().optional(),
});

const rotator = z.object({
  pitch: z.number().optional(),
  yaw: z.number().optional(),
  roll: z.number().optional(),
});

const rgb = z.object({
  r: z.number().min(0).max(255),
  g: z.number().min(0).max(255),
  b: z.number().min(0).max(255),
}).describe("0-255 per channel, matching what list_lights reports.");

// Shared by spawn_light and set_light_property so the two stay in step.
const lightProps = {
  intensity: z.number().optional()
    .describe("Brightness. Units depend on intensityUnits — directional lights are in lux, local lights default to candelas."),
  color: rgb.optional().describe("Light colour, 0-255 per channel."),
  temperature: z.number().min(1000).max(15000).optional()
    .describe("Colour temperature in Kelvin (e.g. 6500 daylight, 3200 tungsten). Setting this enables useTemperature automatically. Not supported on sky lights."),
  useTemperature: z.boolean().optional()
    .describe("Whether the Kelvin temperature is applied at all. Temperature is inert without it."),
  mobility: z.enum(["static", "stationary", "movable"]).optional()
    .describe("Static = fully baked, Stationary = baked GI with dynamic shadows, Movable = fully dynamic. Applied before all other properties, since a Static light rejects most setters."),
  castShadows: z.boolean().optional(),
  affectsWorld: z.boolean().optional()
    .describe("Set false to disable a light without deleting it."),
  indirectLightingIntensity: z.number().optional(),
  volumetricScatteringIntensity: z.number().optional(),
  attenuationRadius: z.number().optional().describe("Point/spot/rect only."),
  intensityUnits: z.enum(["unitless", "candelas", "lumens", "ev", "nits"]).optional()
    .describe("Point/spot/rect only."),
  sourceRadius: z.number().optional().describe("Point/spot only. Drives soft-shadow width and specular size."),
  sourceLength: z.number().optional().describe("Point/spot only."),
  innerConeAngle: z.number().min(0).max(89).optional().describe("Spot only, degrees."),
  outerConeAngle: z.number().min(0).max(89).optional().describe("Spot only, degrees."),
  sourceWidth: z.number().optional().describe("Rect only."),
  sourceHeight: z.number().optional().describe("Rect only."),
  lightSourceAngle: z.number().optional()
    .describe("Directional only. Angular diameter in degrees (~0.526 matches the real sun); larger softens shadows."),
};

function formatLight(l: any, indent = "  "): string[] {
  const lines: string[] = [];
  lines.push(`${indent}${l.label}  [${l.type}, ${l.mobility}]`);
  const bits: string[] = [`intensity ${l.intensity}`];
  if (l.color?.hex) bits.push(`colour ${l.color.hex}`);
  if (l.useTemperature) bits.push(`${l.temperature}K`);
  bits.push(l.castShadows ? "shadows" : "no shadows");
  if (l.affectsWorld === false) bits.push("DISABLED (affectsWorld=false)");
  lines.push(`${indent}  ${bits.join(" · ")}`);

  const typeBits: string[] = [];
  if (l.attenuationRadius !== undefined) typeBits.push(`radius ${l.attenuationRadius}`);
  if (l.intensityUnits) typeBits.push(l.intensityUnits);
  if (l.innerConeAngle !== undefined) typeBits.push(`cone ${l.innerConeAngle}/${l.outerConeAngle}°`);
  if (l.sourceWidth !== undefined) typeBits.push(`${l.sourceWidth}x${l.sourceHeight}`);
  if (l.sourceRadius) typeBits.push(`source r${l.sourceRadius}`);
  if (l.lightSourceAngle !== undefined) typeBits.push(`sun angle ${l.lightSourceAngle}°`);
  if (l.realTimeCapture !== undefined) typeBits.push(l.realTimeCapture ? "realtime capture" : "static capture");
  if (typeBits.length) lines.push(`${indent}  ${typeBits.join(" · ")}`);

  if (l.location) {
    lines.push(`${indent}  at (${Math.round(l.location.x)}, ${Math.round(l.location.y)}, ${Math.round(l.location.z)})`);
  }
  return lines;
}

export function registerLightingTools(server: McpServer): void {
  server.tool(
    "list_lights",
    "List every light in the current level with its type, mobility, intensity, colour, temperature and " +
      "type-specific settings. This is the entry point for assessing or fixing a lighting setup — " +
      "list_actors only returns names and classes.",
    {
      type: z.enum(["directional", "point", "spot", "rect", "sky"]).optional()
        .describe("Only return lights of this type."),
      includeProperties: z.boolean().optional()
        .describe("Include type-specific properties (default true). Set false for a compact roster."),
    },
    async ({ type, includeProperties }) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body: Record<string, unknown> = {};
      if (type) body.type = type;
      if (includeProperties !== undefined) body.includeProperties = includeProperties;

      const data = await uePost("/api/list-lights", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      if (data.count === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No lights in level '${data.level}'.\n\nNext steps:\n  1. spawn_light(type="directional") for a sun\n  2. spawn_light(type="sky") for ambient fill`,
          }],
        };
      }

      const counts = Object.entries(data.countsByType ?? {}).map(([k, v]) => `${v} ${k}`).join(", ");
      const lines = [`${data.count} light${data.count === 1 ? "" : "s"} in '${data.level}' (${counts}):`, ""];
      for (const l of data.lights) lines.push(...formatLight(l), "");

      return { content: [{ type: "text" as const, text: lines.join("\n").trimEnd() }] };
    },
  );

  server.tool(
    "spawn_light",
    "Create a light and configure it in one call. Handles the light-component indirection, applies " +
      "mobility before other properties, and recaptures sky lights automatically.",
    {
      type: z.enum(["directional", "point", "spot", "rect", "sky"])
        .describe("directional = sun, point = omni, spot = cone, rect = area/softbox, sky = ambient environment."),
      label: z.string().optional().describe("Editor display label. Auto-generated if omitted."),
      location: vec3.optional(),
      rotation: rotator.optional()
        .describe("Directional and spot lights emit along their +X axis; pitch -90 points straight down."),
      ...lightProps,
    },
    async (args) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

      const data = await uePost("/api/spawn-light", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Spawned ${data.type} light '${data.label}' (${data.class})`,
        "",
        ...formatLight(data.light),
      ];
      if (data.appliedProperties?.length) {
        lines.push("", `Applied: ${data.appliedProperties.join(", ")}`);
      }
      lines.push(
        "",
        "Next steps:",
        `  1. viewport_capture() to see the result`,
        `  2. set_light_property(label="${data.label}", ...) to adjust`,
        `  3. list_lights() to review the whole setup`,
      );

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "set_light_property",
    "Change one or more properties on an existing light by label. Uses the engine's own setters so " +
      "the viewport updates, applies mobility first, enables useTemperature when you set a " +
      "temperature, and recaptures sky lights (which otherwise ignore property changes entirely).",
    {
      label: z.string().describe("Editor label of the light. Use list_lights to find it."),
      ...lightProps,
    },
    async (args) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

      const data = await uePost("/api/set-light-property", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Updated '${data.label}': ${data.appliedProperties.join(", ")}`,
        "",
        ...formatLight(data.light),
        "",
        "Next steps:",
        `  1. viewport_capture() to see the change`,
        `  2. set_view_mode("LightingOnly") to judge lighting without albedo`,
      ];

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_renderer_state",
    "Report what the renderer is actually doing right now: global illumination method, reflection " +
      "method, shadow map method, and whether path tracing, Lumen hardware ray tracing, MegaLights " +
      "or auto-exposure are on. Reads live console variables rather than project defaults, so it " +
      "reflects the current state rather than what the .ini says.",
    {},
    async () => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const data = await uePost("/api/get-renderer-state", {});
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [
        `Renderer: ${data.activeMode}`,
        "",
        `  Global illumination: ${data.globalIllumination}`,
        `  Reflections:         ${data.reflections}`,
        `  Shadow maps:         ${data.shadowMapMethod}`,
        `  Path tracing:        ${data.pathTracingEnabled ? "on" : "off"}`,
        `  Lumen hardware RT:   ${data.lumenHardwareRayTracing ? "on" : "off"}`,
        `  MegaLights:          ${data.megaLightsEnabled ? "on" : "off"}`,
        `  Auto exposure:       ${data.autoExposureEnabled ? "on" : "off"}`,
      ];
      if (data.lightCount !== undefined) {
        lines.push("", `  Level '${data.level}' has ${data.lightCount} light${data.lightCount === 1 ? "" : "s"}.`);
      }
      if (data.note) lines.push("", `Note: ${data.note}`);

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "set_renderer_mode",
    "Switch the renderer between coherent configurations. 'Use Lumen' is not one setting but a set " +
      "of them (GI method + reflection method + path tracing off); applying a partial combination is " +
      "how you end up with Lumen GI, screen-space reflections and no idea why. This applies them as " +
      "a unit and reports any console variable that does not exist in this build rather than " +
      "silently doing nothing.",
    {
      mode: z.enum(["lumen", "pathtracer", "baked"])
        .describe("lumen = dynamic GI + Lumen reflections. pathtracer = reference path tracing (needs set_view_mode('PathTracing') to actually render). baked = GI from lightmaps, screen-space reflections."),
      hardwareRayTracing: z.boolean().optional().describe("Lumen only. Hardware RT vs software tracing."),
      samplesPerPixel: z.number().min(1).optional().describe("Path tracer only."),
      maxBounces: z.number().min(0).optional().describe("Path tracer only."),
      megaLights: z.boolean().optional()
        .describe("Independent of mode — MegaLights is a light-culling technique, not a GI method."),
      virtualShadowMaps: z.boolean().optional().describe("Independent of mode."),
    },
    async (args) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

      const data = await uePost("/api/set-renderer-mode", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const lines = [`Renderer mode set to '${data.mode}'.`, "", "Applied:"];
      for (const c of data.appliedCVars) lines.push(`  ${c}`);
      if (data.unavailableCVars?.length) {
        lines.push("", `⚠ Not available in this build (had no effect): ${data.unavailableCVars.join(", ")}`);
      }
      if (data.note) lines.push("", `Note: ${data.note}`);
      lines.push("", "Next steps:", "  1. get_renderer_state() to confirm", "  2. viewport_capture() to see it");

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "configure_post_process",
    "Set exposure, bloom and Lumen quality on a post-process volume. Every field of " +
      "FPostProcessSettings is INERT unless its paired bOverride_ flag is also set — writing the " +
      "value through set_actor_property stores it and the renderer ignores it. This sets both, and " +
      "reports the override flags back so you can see the setting is actually live. Auto-exposure " +
      "is the most common reason lighting 'looks wrong'; lockExposure pins it so you can judge " +
      "light intensities directly.",
    {
      volume: z.string().optional()
        .describe("Label of a specific PostProcessVolume. Omit to target the level's unbound (global) volume."),
      createGlobal: z.boolean().optional()
        .describe("If no unbound volume exists, spawn one. Only used when 'volume' is omitted."),
      exposureMethod: z.enum(["histogram", "basic", "manual"]).optional(),
      exposureBias: z.number().optional().describe("EV offset applied on top of the metered exposure."),
      lockExposure: z.number().optional()
        .describe("Pin auto-exposure by setting min and max EV100 to this value — the usual way to stop the image re-normalising while you tune light intensities."),
      exposureMinEV: z.number().optional().describe("Ignored if lockExposure is given."),
      exposureMaxEV: z.number().optional().describe("Ignored if lockExposure is given."),
      bloomIntensity: z.number().optional(),
      lumenSceneLightingQuality: z.number().optional().describe("~0.25-2. Higher is slower."),
      lumenFinalGatherQuality: z.number().optional().describe("~0.25-2. Higher is slower."),
      lumenMaxTraceDistance: z.number().optional().describe("World units."),
    },
    async (args) => {
      const err = await ensureUE();
      if (err) return { content: [{ type: "text" as const, text: err }] };

      const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));

      const data = await uePost("/api/configure-post-process", body);
      if (data.error) return { content: [{ type: "text" as const, text: `Error: ${data.error}` }] };

      const s = data.settings;
      const lines = [
        `Updated post-process volume '${data.volume}'${data.unbound ? " (global/unbound)" : ""}:`,
        ...data.appliedSettings.map((a: string) => `  ${a}`),
        "",
        "Live overrides (a setting only applies when its override is on):",
        `  exposure method: ${s.exposureMethodOverridden ? ["histogram", "basic", "manual"][s.exposureMethod] ?? s.exposureMethod : "not overridden"}`,
        `  exposure bias:   ${s.exposureBiasOverridden ? s.exposureBias : "not overridden"}`,
        `  exposure range:  ${s.exposureMinOverridden ? s.exposureMinEV : "—"} .. ${s.exposureMaxOverridden ? s.exposureMaxEV : "—"} EV100`,
        `  bloom intensity: ${s.bloomIntensityOverridden ? s.bloomIntensity : "not overridden"}`,
      ];
      if (s.exposureMinOverridden && s.exposureMaxOverridden && s.exposureMinEV === s.exposureMaxEV) {
        lines.push("", `Exposure is locked at EV100 ${s.exposureMinEV} — light intensity changes now read directly.`);
      }

      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
