import { describe, it, expect, afterAll } from "vitest";
import { uePost, uniqueName } from "../helpers.js";

// CLAUDE-NOTE: these run against the headless test commandlet, NOT gated behind
// describeEditorOnly. Verified empirically: the commandlet has a valid GEditor and a real UWorld
// ("Untitled_0"), because -nullrhi removes the render device, not the world — and lights are
// ordinary actors. Only things that must actually RENDER (viewport_capture) need a real editor.
// Gating these on editor mode would have meant shipping the lighting logic with every behavioural
// test permanently skipped, since the harness hard-codes port 19847 and nothing serves editor mode
// there.

describe("lighting argument validation", () => {
  describe("spawn_light", () => {
    it("rejects a missing type", async () => {
      const data = await uePost("/api/spawn-light", {});
      expect(data.error).toBeDefined();
      expect(data.error).toContain("type");
      expect(data.errorCode).toBe("invalid_input");
    });

    it("rejects an unknown type and names the valid ones", async () => {
      const data = await uePost("/api/spawn-light", { type: "volumetric" });
      expect(data.error).toBeDefined();
      expect(data.errorCode).toBe("invalid_input");
      expect(data.error).toContain("directional");
    });
  });

  describe("set_light_property", () => {
    it("rejects a missing label", async () => {
      const data = await uePost("/api/set-light-property", { intensity: 5 });
      expect(data.error).toBeDefined();
      expect(data.error).toContain("label");
      expect(data.errorCode).toBe("invalid_input");
    });
  });

  describe("get_renderer_state", () => {
    // Reads console variables, so it works without an editor world.
    it("reports the renderer configuration", async () => {
      const data = await uePost("/api/get-renderer-state", {});
      expect(data.error).toBeUndefined();
      expect(typeof data.globalIllumination).toBe("string");
      expect(typeof data.reflections).toBe("string");
      expect(typeof data.shadowMapMethod).toBe("string");
      expect(typeof data.activeMode).toBe("string");
      expect(typeof data.pathTracingEnabled).toBe("boolean");
      expect(typeof data.megaLightsEnabled).toBe("boolean");
    });
  });
});

describe("lighting tools", () => {
  const spawned: string[] = [];

  async function spawn(type: string, extra: Record<string, unknown> = {}) {
    const label = uniqueName(`TestLight_${type}`);
    const data = await uePost("/api/spawn-light", { type, label, ...extra });
    if (!data.error) spawned.push(data.label);
    return data;
  }

  afterAll(async () => {
    for (const label of spawned) {
      await uePost("/api/delete-actor", { label }).catch(() => {});
    }
  });

  it("spawns a directional light and reports its state", async () => {
    const data = await spawn("directional", { intensity: 3.5, mobility: "movable" });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.type).toBe("directional");
    expect(data.light.type).toBe("directional");
    expect(data.light.mobility).toBe("movable");
    expect(data.light.intensity).toBeCloseTo(3.5, 3);
  });

  it("spawns a spot light with cone angles", async () => {
    const data = await spawn("spot", { innerConeAngle: 10, outerConeAngle: 35 });
    expect(data.error).toBeUndefined();
    expect(data.light.innerConeAngle).toBeCloseTo(10, 1);
    expect(data.light.outerConeAngle).toBeCloseTo(35, 1);
  });

  it("applies colour as 0-255 and round-trips it", async () => {
    const data = await spawn("point", { color: { r: 255, g: 128, b: 0 } });
    expect(data.error).toBeUndefined();
    expect(data.light.color.r).toBe(255);
    expect(data.light.color.g).toBe(128);
    expect(data.light.color.b).toBe(0);
    expect(data.light.color.hex).toBe("#FF8000");
  });

  // Temperature is inert unless bUseTemperature is also set — the tool must not leave it half-applied.
  it("enables useTemperature implicitly when a temperature is set", async () => {
    const data = await spawn("point", { temperature: 3200 });
    expect(data.error).toBeUndefined();
    expect(data.light.temperature).toBeCloseTo(3200, 0);
    expect(data.light.useTemperature).toBe(true);
    expect(data.appliedProperties.join(" ")).toContain("useTemperature=true (implied");
  });

  it("respects an explicit useTemperature=false alongside a temperature", async () => {
    const data = await spawn("point", { temperature: 3200, useTemperature: false });
    expect(data.error).toBeUndefined();
    expect(data.light.useTemperature).toBe(false);
  });

  it("rejects temperature on a sky light rather than silently ignoring it", async () => {
    const label = uniqueName("TestLight_skytemp");
    const data = await uePost("/api/spawn-light", { type: "sky", label, temperature: 5000 });
    expect(data.error).toBeDefined();
    expect(data.error).toContain("sky light");
  });

  it("rejects a type-specific property on the wrong light type", async () => {
    const point = await spawn("point");
    expect(point.error).toBeUndefined();
    const data = await uePost("/api/set-light-property", {
      label: point.label,
      innerConeAngle: 15,
    });
    expect(data.error).toBeDefined();
    expect(data.error).toContain("spot");
  });

  it("rejects attenuationRadius on a directional light", async () => {
    const dir = await spawn("directional");
    expect(dir.error).toBeUndefined();
    const data = await uePost("/api/set-light-property", {
      label: dir.label,
      attenuationRadius: 500,
    });
    expect(data.error).toBeDefined();
    expect(data.error).toContain("point, spot, and rect");
  });

  it("updates an existing light and reports what changed", async () => {
    const light = await spawn("point", { intensity: 1000 });
    expect(light.error).toBeUndefined();

    const data = await uePost("/api/set-light-property", {
      label: light.label,
      intensity: 5000,
      attenuationRadius: 1200,
      castShadows: false,
    });
    expect(data.error).toBeUndefined();
    expect(data.success).toBe(true);
    expect(data.light.intensity).toBeCloseTo(5000, 1);
    expect(data.light.attenuationRadius).toBeCloseTo(1200, 1);
    expect(data.light.castShadows).toBe(false);
    expect(data.appliedProperties).toHaveLength(3);
  });

  // CLAUDE-NOTE: regression guard for the bug these tests caught. UE's SetAttenuationRadius /
  // SetInnerConeAngle / SetOuterConeAngle are gated on AreDynamicDataChangesAllowed(false), which
  // refuses STATIONARY — the default mobility of a newly placed light — and every other Set* light
  // function refuses STATIC. The setters return void, so the rejection was completely silent: the
  // tool reported success while the value never changed. Now written as direct property
  // assignments, which is what the editor's details panel does.
  it("applies radius and cone angles on a stationary light", async () => {
    const spot = await spawn("spot", { mobility: "stationary" });
    expect(spot.error).toBeUndefined();
    expect(spot.light.mobility).toBe("stationary");

    const data = await uePost("/api/set-light-property", {
      label: spot.label,
      attenuationRadius: 1750,
      innerConeAngle: 12,
      outerConeAngle: 44,
    });
    expect(data.error).toBeUndefined();
    expect(data.light.attenuationRadius).toBeCloseTo(1750, 1);
    expect(data.light.innerConeAngle).toBeCloseTo(12, 1);
    expect(data.light.outerConeAngle).toBeCloseTo(44, 1);
  });

  it("applies properties on a static light", async () => {
    const point = await spawn("point", { mobility: "static" });
    expect(point.error).toBeUndefined();
    expect(point.light.mobility).toBe("static");

    const data = await uePost("/api/set-light-property", {
      label: point.label,
      intensity: 7777,
      attenuationRadius: 640,
    });
    expect(data.error).toBeUndefined();
    expect(data.light.intensity).toBeCloseTo(7777, 1);
    expect(data.light.attenuationRadius).toBeCloseTo(640, 1);
  });

  it("applies cone angles at spawn time, not just afterwards", async () => {
    const spot = await spawn("spot", { innerConeAngle: 8, outerConeAngle: 27 });
    expect(spot.error).toBeUndefined();
    expect(spot.light.innerConeAngle).toBeCloseTo(8, 1);
    expect(spot.light.outerConeAngle).toBeCloseTo(27, 1);
  });

  it("recaptures a sky light after a property change", async () => {
    const sky = await spawn("sky");
    expect(sky.error).toBeUndefined();
    const data = await uePost("/api/set-light-property", { label: sky.label, intensity: 2 });
    expect(data.error).toBeUndefined();
    expect(data.appliedProperties).toContain("recapturedSky");
  });

  it("errors when no properties are supplied", async () => {
    const light = await spawn("point");
    const data = await uePost("/api/set-light-property", { label: light.label });
    expect(data.error).toBeDefined();
    expect(data.error).toContain("No light properties supplied");
  });

  it("rejects an unknown mobility", async () => {
    const light = await spawn("point");
    const data = await uePost("/api/set-light-property", { label: light.label, mobility: "welded" });
    expect(data.error).toBeDefined();
    expect(data.error).toContain("stationary");
  });

  it("returns not_found for a non-existent label", async () => {
    const data = await uePost("/api/set-light-property", {
      label: "NoSuchLight_XYZ_999",
      intensity: 1,
    });
    expect(data.error).toBeDefined();
    expect(data.errorCode).toBe("not_found");
  });

  it("refuses a non-light actor and points at set_actor_property", async () => {
    const cube = uniqueName("TestCube");
    const spawnRes = await uePost("/api/spawn-actor", { class: "StaticMeshActor", label: cube });
    expect(spawnRes.error).toBeUndefined();
    try {
      const data = await uePost("/api/set-light-property", { label: cube, intensity: 5 });
      expect(data.error).toBeDefined();
      expect(data.error).toContain("set_actor_property");
    } finally {
      await uePost("/api/delete-actor", { label: cube }).catch(() => {});
    }
  });

  describe("list_lights", () => {
    it("finds the lights that were spawned", async () => {
      await spawn("rect", { sourceWidth: 200, sourceHeight: 100 });
      const data = await uePost("/api/list-lights", {});
      expect(data.error).toBeUndefined();
      expect(data.count).toBeGreaterThan(0);
      expect(Array.isArray(data.lights)).toBe(true);
      const rect = data.lights.find((l: any) => l.type === "rect");
      expect(rect).toBeDefined();
      expect(rect.sourceWidth).toBeCloseTo(200, 1);
    });

    it("filters by type", async () => {
      await spawn("spot");
      const data = await uePost("/api/list-lights", { type: "spot" });
      expect(data.error).toBeUndefined();
      expect(data.lights.every((l: any) => l.type === "spot")).toBe(true);
    });

    it("omits type-specific properties when includeProperties is false", async () => {
      await spawn("point", { attenuationRadius: 900 });
      const data = await uePost("/api/list-lights", { type: "point", includeProperties: false });
      expect(data.error).toBeUndefined();
      expect(data.lights.length).toBeGreaterThan(0);
      expect(data.lights[0].attenuationRadius).toBeUndefined();
      // Base properties are still present.
      expect(typeof data.lights[0].intensity).toBe("number");
    });

    it("classifies a spot light as spot, not point", async () => {
      // ASpotLight derives from APointLight, so a naive IsA check reports the wrong type.
      const spot = await spawn("spot");
      const data = await uePost("/api/list-lights", { type: "spot" });
      const found = data.lights.find((l: any) => l.label === spot.label);
      expect(found).toBeDefined();
      expect(found.type).toBe("spot");
    });
  });
});
