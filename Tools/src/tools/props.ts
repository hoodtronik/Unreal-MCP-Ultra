import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ensureUE, uePost } from "../ue-bridge.js";
import { runPose, type PoseResult } from "./posing.js";

// CLAUDE-NOTE (2026-10-21): PROPS held by characters in a LevelSequence (Tools/python/ue_props.py). The prop is a
// spawnable attached through a Sequencer Attach track (not a level attach - characters are spawnables), so it
// rides the bone through the whole animation. A 'grip' lays the prop on the open hand's measured SKIN and then
// curls each finger joint by bisection until that finger's skin just touches it. Live finding behind the design
// (Manny, 7 cm cup): bone-only placement left the curled fingers 3.5 cm inside the cup, and a uniform 'grip'
// hand shape drove the distal segments through it - only per-joint contact readback produced a wrap.

const LIBS = ["ue_posing.py", "ue_props.py"];
const vec3 = z.array(z.number()).length(3);
const FINGERS = ["index", "middle", "ring", "pinky"] as const;
const JOINTS = ["01", "02", "03"] as const;
const MAX_CURL_DEG = 90;
const MAX_THUMB_ROLL_DEG = 70;
const ITER = 7; // 90 / 2^7 = 0.7 deg resolution
// Skin is allowed to press this far into the prop (a real grip compresses the pads); deeper = penetration.
export const PRESS_CM = 0.2;

function text(t: string, isError = false) {
  return { content: [{ type: "text" as const, text: t }], ...(isError ? { isError: true } : {}) };
}

async function run(call: string, params: Record<string, unknown>): Promise<PoseResult> {
  return runPose(call, params, LIBS);
}

/** Gap of ONE finger segment (the phalanx that starts at joint j). Exported for tests.
 * CLAUDE-NOTE (2026-10-21, live): bisecting joint 01 on the gap of the whole finger stopped at 46/2/2 deg - the
 * straight fingertip touched first and the finger stuck out like a stick. A wrap makes each phalanx tangent in
 * turn; the straight continuation of a tangent segment leaves the circle, so later segments are solved next. */
export function gapFrom(seg: Record<string, number>, finger: string, j: number): number {
  const v = seg[`${finger}_${JOINTS[j]}`];
  return typeof v === "number" ? v : Infinity;
}

/** Closest gap over all segments of a finger. Exported for tests. */
export function fingerGap(seg: Record<string, number>, finger: string): number {
  return Math.min(...JOINTS.map((_, j) => gapFrom(seg, finger, j)));
}

// CLAUDE-NOTE (2026-10-21, live): wrapping a cylinder bends each joint by about the angle its phalanx subtends,
// so the joints curl nearly equally (the 'fist' profile -75/-95/-60 drove the middle phalanx through a 7 cm cup).
// Per-joint sequential solving failed both ways: whole-finger gaps stopped 01 at 46 deg (tip touched first),
// segment-only gaps let 01 swing until its END hit the cup and left 02/03 3 cm inside.
export const WRAP = [1, 1, 0.8];
export function wrapCurl(deg: number): number[] {
  return WRAP.map((r) => r * deg);
}

/** One bisection step: keep the largest angle whose gap is not penetrating. Exported for tests. */
export function bisect(lo: number, hi: number, mid: number, gap: number): [number, number] {
  return gap >= -PRESS_CM ? [mid, hi] : [lo, mid];
}

// CLAUDE-NOTE (2026-10-22, live 5.6.1): prop_socket turns a solved grip into a SKELETON socket so the same hold is
// reusable (any prop / any character on that skeleton: Manny and Quinn share SK_Mannequin). Python cannot write
// sockets (SkeletalMeshSocket.socket_name read-only, Skeleton.sockets protected), so the socket is written by the
// plugin's /api/add-skeleton-socket and everything around it (offset, readback, switch, check) is ue_socket.py.
export const SOCKET_TOL_CM = 0.05;
export const SOCKET_TOL_DEG = 0.05;
const SOCKET_LIBS = ["ue_posing.py", "ue_props.py", "ue_socket.py"];

/** Largest per-component difference between two vectors (stored vs measured socket values). Exported for tests. */
export function maxDiff(a: number[], b: number[]): number {
  return Math.max(...a.map((v, i) => Math.abs(v - b[i])));
}

/** Rotator components compared modulo 360. Exported for tests. */
export function maxAngleDiff(a: number[], b: number[]): number {
  return Math.max(...a.map((v, i) => {
    const d = Math.abs(((v - b[i]) % 360 + 540) % 360 - 180);
    return d;
  }));
}

/** Angle in degrees between two unit quaternions [x,y,z,w]. Exported for tests. */
export function quatAngleDeg(a: number[], b: number[]): number {
  const d = Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]));
  return (2 * Math.acos(d) * 180) / Math.PI;
}

export function registerPropTools(server: McpServer): void {
  server.tool(
    "prop_attach",
    "Give a character a PROP that follows a bone through the sequence (cup, phone, sword, bag...). Adds the static " +
      "mesh as a spawnable with a Sequencer Attach track to the character's bone/socket, sized by 'size' (cm bounding " +
      "box) and optionally tinted. With grip:'l'|'r' it solves a power grip at 'frame': opens the hand, lays the prop " +
      "(treated as a cylinder along its local Z, e.g. /Engine/BasicShapes/Cylinder) on the measured palm skin, then " +
      "curls every finger joint and swings the thumb until each just touches it, and reports per-finger skin gaps. " +
      "Pose the arm first (pose_reach/pose_palm); the grip is stored in bone space so it rides any later animation. " +
      "Check motion with prop_check.",
    {
      sequence: z.string(),
      name: z.string().describe("Prop binding name, e.g. 'Cup'."),
      character: z.string().describe("Character binding that holds it."),
      bone: z.string().optional().describe("Bone/socket to attach to. Default hand_<grip side>, else hand_r. With grip on a SOCKET (saved by prop_socket) the prop sits on it at zero offset and only the fingers are solved."),
      mesh: z.string().optional().describe("StaticMesh path. Default /Engine/BasicShapes/Cylinder."),
      size: vec3.optional().describe("Bounding-box size [x,y,z] cm; scales the mesh. Default: mesh size."),
      color: vec3.optional().describe("Tint [r,g,b] 0-1 (BasicShapeMaterial instance saved beside the sequence)."),
      grip: z.enum(["l", "r"]).optional().describe("Solve a power grip in that hand."),
      offset: vec3.optional().describe("Without grip: location in bone space, cm."),
      rotation: vec3.optional().describe("Without grip: [roll,pitch,yaw] in bone space, deg."),
      frame: z.number().int().optional().describe("Frame whose pose the grip is solved at and keyed on. Default 0."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const side = a.grip;
      const bone = a.bone ?? `hand_${side ?? "r"}`;
      const f = a.frame ?? 0;
      const base = { s: a.sequence, n: a.name, c: a.character, b: bone };
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f });
      if (side) {
        const o = await run("hand_shape(P['s'], P['c'], P['side'], 'open', P['f'])", { ...base, side, f });
        if (!o.ok) return text(`Error opening the hand: ${o.error}`, true);
      }
      const at = await run(
        "prop_attach(P['s'], P['n'], P['c'], P['b'], P['mesh'], P['size'], P['off'], P['rot'], P['grip'], P['color'])",
        { ...base, mesh: a.mesh ?? null, size: a.size ?? null, off: a.offset ?? null, rot: a.rotation ?? null, grip: side ?? null, color: a.color ?? null },
      );
      if (!at.ok) return text(`Error: ${at.error}`, true);
      const lines = [
        `${at.created ? "Added" : "Updated"} prop '${a.name}' (${at.mesh}, ${JSON.stringify(at.size)} cm) on ${a.character}.${bone}: ` +
          `offset ${JSON.stringify(at.offset)} rot ${JSON.stringify(at.rotation)} (bone space).`,
      ];
      if (!side) {
        const st = await run("prop_state(P['s'], P['n'], P['c'], P['b'])", base);
        if (!st.ok) return text(`${lines[0]}\nReadback failed: ${st.error}`, true);
        const ok = st.attached_to === bone;
        lines.push(`${ok ? "Verified" : "NOT ATTACHED:"} attached to '${st.attached_to}', world ${JSON.stringify(st.prop_world)}.`);
        return text(lines.join("\n"), !ok);
      }
      // Grip solve: one curl amount per finger spread as an even arc over its joints (WRAP ratios), bisected on
      // the finger's closest skin gap; the thumb rolls out in parallel until it clears.
      const ang: Record<string, number[]> = Object.fromEntries(FINGERS.map((fn) => [fn, [0, 0, 0]]));
      let thumb = 0;
      const key = (curl: Record<string, number[]>, th: number) => {
        const controls: any[] = [];
        for (const fn of FINGERS) JOINTS.forEach((j, i) => controls.push({ control: `${fn}_${j}_${side}_ctrl`, rotation: [0, -curl[fn][i], 0] }));
        controls.push({ control: `thumb_01_${side}_ctrl`, rotation: [th, 0, 0] });
        return run("set_controls(P['s'], P['c'], P['f'], P['ctl'])", { ...base, f, ctl: controls });
      };
      const read = () => run("prop_state(P['s'], P['n'], P['c'], P['b'], side=P['side'])", { ...base, side });
      const lo: Record<string, number> = Object.fromEntries(FINGERS.map((fn) => [fn, 0]));
      const hi: Record<string, number> = Object.fromEntries(FINGERS.map((fn) => [fn, MAX_CURL_DEG]));
      let tlo = 0, thi = MAX_THUMB_ROLL_DEG;
      for (let it = 0; it < ITER; it++) {
        const trial = Object.fromEntries(FINGERS.map((fn) => [fn, wrapCurl((lo[fn] + hi[fn]) / 2)]));
        const tmid = (tlo + thi) / 2;
        const w = await key(trial, tmid);
        if (!w.ok) return text(`Error keying the grip: ${w.error}`, true);
        const st = await read();
        if (!st.ok) return text(`Grip readback failed: ${st.error}`, true);
        const seg = st.grip.segment_gaps_cm as Record<string, number>;
        for (const fn of FINGERS) [lo[fn], hi[fn]] = bisect(lo[fn], hi[fn], (lo[fn] + hi[fn]) / 2, fingerGap(seg, fn));
        // thumb: rolling OUT opens the gap, so keep the smallest roll that clears
        if (fingerGap(seg, "thumb") >= -PRESS_CM) thi = tmid; else tlo = tmid;
      }
      for (const fn of FINGERS) ang[fn] = wrapCurl(lo[fn]);
      thumb = thi;
      const w = await key(ang, thumb);
      if (!w.ok) return text(`Error keying the grip: ${w.error}`, true);
      const st = await read();
      if (!st.ok) return text(`Grip readback failed: ${st.error}`, true);
      const g = st.grip.gaps_cm as Record<string, number>;
      const touching = [...FINGERS, "thumb"].filter((fn) => typeof g[fn] === "number" && g[fn] <= 1.0);
      const deepest = Math.min(...Object.values(g));
      const ok = st.attached_to === bone && deepest >= -1.0 && touching.length >= 3;
      lines.push(
        `${ok ? "Grip verified" : "GRIP NOT CLEAN:"} ${touching.length}/5 digits within 1 cm of the prop (${touching.join(", ") || "none"}); ` +
          `deepest skin ${deepest.toFixed(2)} cm; ${st.grip.skin_inside_verts} skin verts inside.`,
        `Skin gaps cm (negative = inside): ${JSON.stringify(g)}`,
        `Curls deg (01/02/03): ${FINGERS.map((fn) => `${fn} ${ang[fn].map((v) => v.toFixed(0)).join("/")}`).join(", ")}; thumb roll ${thumb.toFixed(0)}.`,
      );
      return text(lines.join("\n"), !ok);
    },
  );

  server.tool(
    "prop_check",
    "Play a prop through frames and read it back: that it stays on its bone (bone-space offset drift), where it is " +
      "in the world, its distance to a target (e.g. a cup to the mouth: {binding:'Hero', bone:'head', offset:[0,-10,-8]}), " +
      "and with side the grip skin gaps per frame. One request per frame (poses apply on the editor tick).",
    {
      sequence: z.string(),
      name: z.string(),
      character: z.string(),
      bone: z.string().optional().describe("Default hand_r."),
      frames: z.array(z.number().int()).min(1).max(60),
      side: z.enum(["l", "r"]).optional().describe("Also measure the grip of that hand."),
      near: z.object({ binding: z.string().optional(), actor: z.string().optional(), bone: z.string().optional(), offset: vec3.optional() }).strict().optional(),
      driftCm: z.number().optional().describe("Max allowed offset drift, default 0.1 cm."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const base = { s: a.sequence, n: a.name, c: a.character, b: a.bone ?? "hand_r", side: a.side ?? null, near: a.near ?? null };
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frames[0] });
      await run("scrub(P['s'], P['f'])", { s: a.sequence, f: a.frames[0] }); // settle: the first scrub may land a tick late
      const rows: PoseResult[] = [];
      for (let i = 0; i < a.frames.length; i++) {
        const next = i + 1 < a.frames.length ? a.frames[i + 1] : null;
        const r = await run("prop_state(P['s'], P['n'], P['c'], P['b'], side=P['side'], next_frame=P['nx'], near=P['near'])", { ...base, nx: next });
        if (!r.ok) return text(`Error at frame ${a.frames[i]}: ${r.error}`, true);
        rows.push(r);
      }
      const o0 = rows[0].offset as number[];
      const drift = Math.max(...rows.map((r) => Math.hypot(...(r.offset as number[]).map((v, k) => v - o0[k]))));
      const tol = a.driftCm ?? 0.1;
      const wrongFrame = rows.filter((r, i) => r.frame !== a.frames[i]).length;
      const detached = rows.filter((r) => r.attached_to !== base.b).length;
      const bodyHits = rows.filter((r) => (r.grip?.body_deepest_cm ?? 0) > 0.5).length;
      const ok = drift <= tol && wrongFrame === 0 && detached === 0 && bodyHits === 0;
      const lines = [`${ok ? "Prop holds" : "PROP CHECK FAILED:"} '${a.name}' on ${a.character}.${base.b} over ${rows.length} frames: offset drift ${drift.toFixed(3)} cm (tol ${tol})` +
        `${detached ? `, ${detached} frames not attached` : ""}${wrongFrame ? `, ${wrongFrame} frames read at the wrong time` : ""}` +
        `${bodyHits ? `, the prop goes into the body on ${bodyHits} frames` : ""}.`];
      for (const r of rows) {
        const g = r.grip ? ` | hand min gap ${Math.min(...(Object.values(r.grip.gaps_cm) as number[])).toFixed(2)} cm (${r.grip.skin_inside_verts} verts in)` +
          (r.grip.body_inside_verts ? ` | BODY INSIDE PROP ${r.grip.body_inside_verts} verts, ${r.grip.body_deepest_cm} cm deep` : "") : "";
        lines.push(`  f${r.frame}: ${JSON.stringify(r.prop_world)}${r.near_cm != null ? ` - ${r.near_cm} cm to target` : ""}${g}`);
      }
      return text(lines.join("\n"), !ok);
    },
  );

  server.tool(
    "prop_key",
    "Add (or update) a FREE prop in a LevelSequence and key its WORLD location/rotation at frames - a sliding tray, " +
      "an opening door, a cart. Not attached to anyone (use prop_attach for held props); it is the moving parent for " +
      "pose_constrain. Verified: the rendered actor sits at every keyed location.",
    {
      sequence: z.string(),
      name: z.string().describe("Binding name of the prop (created if missing)."),
      keys: z.array(z.object({ frame: z.number().int(), location: vec3.optional(), rotation: vec3.optional().describe("[roll, pitch, yaw] deg") })).min(1),
      mesh: z.string().optional().describe("StaticMesh for a new prop (default /Engine/BasicShapes/Cube)."),
      size: vec3.optional().describe("Bounding box in cm (scales the mesh)."),
      color: vec3.optional().describe("[r,g,b] 0-1 tint."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const r = await run("prop_key(P['s'], P['n'], P['k'], P['m'], P['z'], P['c'])", {
        s: a.sequence, n: a.name, k: a.keys, m: a.mesh ?? null, z: a.size ?? null, c: a.color ?? null,
      });
      if (!r.ok) return text(`Error: ${r.error}`, true);
      // CLAUDE-NOTE: read the rendered actor back at each keyed frame (scrub twice: actors refresh between calls).
      let worst = 0;
      const lines = [`${r.created ? "Created" : "Updated"} prop ${a.name}, keyed frames ${r.frames.join(",")}.`];
      for (const k of a.keys.filter((k) => k.location)) {
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f: k.frame });
        await run("scrub(P['s'], P['f'])", { s: a.sequence, f: k.frame });
        const w = await run("prop_where(P['s'], P['n'])", { s: a.sequence, n: a.name });
        if (!w.ok) return text([...lines, `Readback failed at ${k.frame}: ${w.error}`].join("\n"), true);
        const d = Math.hypot(...w.location.map((v: number, i: number) => v - (k.location as number[])[i]));
        worst = Math.max(worst, d);
        lines.push(`  frame ${k.frame}: at [${w.location.join(", ")}]`);
      }
      const ok = worst <= 0.1;
      lines.push(`${ok ? "Verified" : "MISMATCH"}: worst ${Math.round(worst * 1000) / 1000} cm from the keyed locations.`);
      return text(lines.join("\n"), !ok);
    },
  );

  server.tool(
    "prop_socket",
    "Save where a prop sits in the hand (e.g. after prop_attach grip) as a SOCKET on the character's skeleton, so " +
      "the same hold can be reused: prop_attach with bone=<socket> puts any prop there at zero offset (with grip it " +
      "then only curls the fingers), on every character that shares the skeleton. Measures the prop's offset from " +
      "its bone at `frame`, writes the socket (saved to disk; overwrites a socket of the same name), reads it back, " +
      "and with switch (default) re-attaches the prop to the socket and VERIFIES it did not move.",
    {
      sequence: z.string(),
      prop: z.string().describe("Prop binding (from prop_attach)."),
      character: z.string().describe("Character binding the prop is attached to."),
      socket: z.string().describe("Socket name to create/update, e.g. 'Cup_Grip_R'."),
      frame: z.number().int().optional().describe("Frame to measure at. Default 0."),
      switch: z.boolean().optional().describe("Re-attach the prop to the new socket at zero offset. Default true."),
    },
    async (a) => {
      const err = await ensureUE();
      if (err) return text(err, true);
      const sr = (call: string, p: Record<string, unknown>) => runPose(call, p, SOCKET_LIBS);
      const base = { s: a.sequence, n: a.prop, c: a.character, k: a.socket };
      const f = a.frame ?? 0;
      await sr("scrub(P['s'], P['f'])", { s: a.sequence, f });
      await sr("scrub(P['s'], P['f'])", { s: a.sequence, f });
      const off = await sr("socket_offset(P['s'], P['n'], P['c'])", base);
      if (!off.ok) return text(`Error: ${off.error}`, true);
      const [lx, ly, lz] = off.location as number[];
      const [roll, pitch, yaw] = off.rotation as number[];
      const w = await uePost("/api/add-skeleton-socket", {
        path: off.skeleton, socketName: a.socket, bone: off.bone, locX: lx, locY: ly, locZ: lz,
        rotRoll: roll, rotPitch: pitch, rotYaw: yaw, overwrite: true,
      });
      if (w.error || !w.success) return text(`Error writing the socket: ${w.error ?? "not saved"}`, true);
      const got = await sr("socket_get(P['s'], P['c'], P['k'])", base);
      const sock = got.ok ? got.socket : null;
      if (!sock) return text(`Socket write reported success but ${a.character}'s mesh has no socket '${a.socket}'.`, true);
      const dl = maxDiff(sock.location, off.location as number[]);
      const da = maxAngleDiff(sock.rotation, off.rotation as number[]);
      const stored = dl <= 0.01 && da <= 0.01 && sock.bone === off.bone && sock.owner === "skeleton";
      const lines = [
        `${w.created ? "Created" : "Updated"} socket '${a.socket}' on ${off.skeleton} (bone ${off.bone}): ` +
          `loc ${JSON.stringify(sock.location)} rot ${JSON.stringify(sock.rotation)} (saved).`,
        `${stored ? "Stored values verified" : "STORED VALUES DIFFER:"} (max ${dl.toFixed(3)} cm / ${da.toFixed(3)} deg vs the measured offset).`,
      ];
      if (a.switch === false) return text(lines.join("\n"), !stored);
      const sw = await sr("socket_switch(P['s'], P['n'], P['k'])", base);
      if (!sw.ok) return text(`${lines.join("\n")}\nError switching the prop: ${sw.error}`, true);
      await sr("scrub(P['s'], P['f'])", { s: a.sequence, f });
      await sr("scrub(P['s'], P['f'])", { s: a.sequence, f });
      const ck = await sr("socket_check(P['s'], P['n'], P['c'], P['k'])", base);
      if (!ck.ok) return text(`${lines.join("\n")}\nCheck failed: ${ck.error}`, true);
      const moved = maxDiff(ck.prop_world, off.prop_world as number[]);
      // CLAUDE-NOTE: the prop sits ON the socket after the switch, so prop-vs-socket is ~0 by construction; a wrong
      // socket ROTATION would only show as the prop turning in place - compare its world rotation before/after too.
      const turned = quatAngleDeg(ck.prop_quat, off.prop_quat as number[]);
      const ok = stored && ck.attached_to === a.socket && moved <= SOCKET_TOL_CM && turned <= SOCKET_TOL_DEG &&
        ck.dist_cm <= SOCKET_TOL_CM && ck.angle_deg <= SOCKET_TOL_DEG;
      lines.push(
        `${ok ? "Verified" : "SWITCH CHECK FAILED:"} '${a.prop}' now on '${ck.attached_to}' at zero offset: moved ${moved.toFixed(3)} cm, turned ${turned.toFixed(3)} deg; ` +
          `prop vs socket ${ck.dist_cm} cm / ${ck.angle_deg} deg.`,
        `Reuse: prop_attach bone='${a.socket}' (with grip: fingers only) on any character with this skeleton.`,
      );
      return text(lines.join("\n"), !ok);
    },
  );
}
