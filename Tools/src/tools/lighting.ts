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
}
