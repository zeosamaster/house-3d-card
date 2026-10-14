// The 3D stage: every storey stacked, a house view (geometry only) and a room view (that
// room's lamps and ACs live). Adapted from House Control's world.js.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildHouse } from './three/house.js';
import { buildFurniture } from './three/furniture.js';
import { LightUnit } from './three/lights.js';
import { ACUnit } from './three/ac.js';
import { roomGroup, boundsOf } from './plan.js';
import { createSky } from './sky.js';
import { createGlows } from './glow.js';

export const STAGE_BG = '#0a0e1a';
const rad = THREE.MathUtils.degToRad;
const clamp = THREE.MathUtils.clamp;
const EL_MIN = 22;
const EL_MAX = 75;
const ZOOM_MIN = 0.35;
const ZOOM_MAX = 1.4;
const LONG_PRESS_MS = 500;
const WALL_SIDE = { north: -14, west: 14, south: 0, east: 0 };

export function createStage(canvas, plan, { onPick, onLongPress, onMove, capsOf, intro = false }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // static model: shadow maps only when something changes

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(STAGE_BG);
  const camera = new THREE.PerspectiveCamera(24, 1, 0.5, 300);

  const { minX, minZ, maxX, maxZ } = plan.bounds;
  const H = plan.wallHeight;
  const center = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  const span = Math.max(maxX - minX, maxZ - minZ, 6);
  const baseAz = plan.camera.azimuth;

  /* ---------- content: one group per storey ---------- */

  const levels = plan.levels.map((cfg, i) => {
    const group = new THREE.Group();
    group.position.y = cfg.elevation;
    const house = buildHouse(cfg, { plinth: false });
    const furniture = buildFurniture(cfg.furniture);
    group.add(house.group, furniture);
    scene.add(group);
    // TVs linked to a media_player: their screen lights up while it plays.
    const screens = [];
    furniture.children.forEach((g) => {
      if (!g.userData.item?.entity) return;
      g.traverse((o) => { if (o.userData.screen) screens.push({ entity: g.userData.item.entity, material: o.material }); });
    });
    return { cfg, group, floors: house.floors, cutaways: house.cutaways, windows: house.windows, alerts: house.alerts, screens, index: i };
  });
  const levelOf = (id) => levels.find((l) => l.cfg.id === id);
  const roomOf = (levelId, roomId) => levelOf(levelId)?.cfg.rooms.find((r) => r.id === roomId);

  // One plinth under the whole footprint.
  const plinth = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX + 1.2, 0.3, maxZ - minZ + 1.2),
    new THREE.MeshStandardMaterial({ color: '#46503c', roughness: 1 })); // earth: reads as ground by day, dark at night
  plinth.position.set(center.x, -0.155, center.z);
  plinth.receiveShadow = true;
  scene.add(plinth);

  // Light comes from the real sun (sun.sun) by day and a soft moon at night; see sky.js.
  const sky = createSky(scene, center, span);
  sky.setNorth(plan.north);
  sky.update();
  // Whole-house view: glowing bulbs + pools of light for every lamp that's on; see glow.js.
  const glows = createGlows(levels, H);

  const target = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: 4 });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new UnrealBloomPass(new THREE.Vector2(4, 4), 0.34, 0.5, 1.0));
  composer.addPass(new OutputPass());

  /* ---------- view state ---------- */

  let peel = null;  // house view: hide storeys above this one (null = whole house)
  let room = null;  // room view: { level, id, ids } — ids: every rect of the room's area
  let units = [];   // LightUnit / ACUnit of the focused room

  const topVisible = () => {
    const capId = room?.level ?? peel;
    const cap = capId ? levelOf(capId).cfg.elevation : Infinity;
    return levels.filter((l) => l.cfg.elevation <= cap);
  };

  function applyVisibility() {
    const visible = new Set(topVisible());
    for (const l of levels) l.group.visible = visible.has(l);
    sky.update({ dim: Boolean(room) });
    glows.hide(new Set(units.filter((u) => u.kind === 'light').map((u) => u.id)));
    shadowFrames = 3;
  }

  /* ---------- camera rig ---------- */

  const rig = {
    az: baseAz, el: plan.camera.elevation, dist: 40, target: center.clone(),
    goal: { az: baseAz, el: plan.camera.elevation, dist: 40, target: center.clone() }, zoom: 1,
  };
  let width = 1;
  let height = 1;
  const v = new THREE.Vector3();
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();

  function basis(az, el) {
    const a = rad(az);
    const e = rad(el);
    fwd.set(-Math.sin(a) * Math.cos(e), -Math.sin(e), -Math.cos(a) * Math.cos(e));
    right.set(Math.cos(a), 0, -Math.sin(a));
    up.crossVectors(right, fwd);
  }

  function fitDistance(box, az, el, fill) {
    basis(az, el);
    const c = box.getCenter(new THREE.Vector3());
    const tanV = Math.tan(rad(camera.fov / 2)) * fill;
    const tanH = tanV * camera.aspect;
    let dist = 0;
    for (let i = 0; i < 8; i++) {
      v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).sub(c);
      const depth = v.dot(fwd);
      dist = Math.max(dist, Math.abs(v.dot(right)) / tanH - depth, Math.abs(v.dot(up)) / tanV - depth);
    }
    return { dist, center: c };
  }

  function frameGoal() {
    let box;
    let fill = 0.92;
    if (room) {
      const rs = levelOf(room.level).cfg.rooms.filter((r) => room.ids.includes(r.id));
      const y = levelOf(room.level).cfg.elevation;
      box = new THREE.Box3(
        new THREE.Vector3(Math.min(...rs.map((r) => r.bx0)), y, Math.min(...rs.map((r) => r.bz0))),
        new THREE.Vector3(Math.max(...rs.map((r) => r.bx1)), y + H * 0.75, Math.max(...rs.map((r) => r.bz1))));
      fill = 0.84;
    } else {
      // Frame the house itself plus a few metres of garden; the rest of the plot runs off the
      // edges (on a portrait phone, fitting the whole plot left the house tiny).
      const vis = topVisible();
      const top = Math.max(...vis.map((l) => l.cfg.elevation)) + H * 0.8;
      const indoor = levels.flatMap((l) => l.cfg.rooms).filter((r) => !r.outdoor);
      const b = indoor.length ? boundsOf(indoor) : plan.bounds;
      const m = camera.aspect < 0.8 ? 0.6 : 2.5; // portrait phones: let the garden crop, keep the house big
      box = new THREE.Box3(new THREE.Vector3(b.minX - m, 0, b.minZ - m), new THREE.Vector3(b.maxX + m, top, b.maxZ + m));
    }
    const { dist, center: c } = fitDistance(box, rig.goal.az, rig.goal.el, fill);
    rig.goal.dist = dist * rig.zoom;
    rig.goal.target.copy(c);
  }

  function updateRig(dt, instant = false) {
    const k = instant ? 1 : 1 - Math.exp(-dt * 5.5);
    const g = rig.goal;
    const delta = Math.abs(g.az - rig.az) + Math.abs(g.el - rig.el) + Math.abs(g.dist - rig.dist) * 2
      + rig.target.distanceTo(g.target) * 4;
    rig.az += (g.az - rig.az) * k;
    rig.el += (g.el - rig.el) * k;
    rig.dist += (g.dist - rig.dist) * k;
    rig.target.lerp(g.target, k);
    basis(rig.az, rig.el);
    camera.position.copy(rig.target).addScaledVector(fwd, -rig.dist);
    camera.lookAt(rig.target);
    cutaway();
    return delta > 0.002;
  }

  // Exterior walls facing the camera drop to a curb; re-picked whenever the camera turns.
  const toCamera = new THREE.Vector3();
  let cutAz = null;
  function cutaway() {
    const az = Math.round(rig.az);
    if (az === cutAz) return;
    cutAz = az;
    toCamera.set(Math.sin(rad(rig.az)), 0, Math.cos(rad(rig.az)));
    let changed = false;
    for (const l of levels) {
      for (const c of l.cutaways) {
        const near = c.normal.dot(toCamera) > 0.15;
        if (c.curb.visible !== near) { c.curb.visible = near; c.full.visible = !near; changed = true; }
      }
    }
    if (changed) shadowFrames = Math.max(shadowFrames, 2);
  }

  /* ---------- room units ---------- */

  function clearUnits() {
    for (const u of units) {
      u.group.parent?.remove(u.group);
      u.group.traverse((o) => { o.geometry?.dispose?.(); if (o.isLight) o.dispose?.(); });
    }
    units = [];
  }

  function buildUnits() {
    clearUnits();
    if (!room) return;
    const lv = levelOf(room.level);
    for (const cfg of lv.cfg.lights.filter((l) => room.ids.includes(l.room))) {
      const u = new LightUnit({ ...cfg, capabilities: cfg.capabilities || capsOf(cfg) }, H);
      u.kind = 'light';
      lv.group.add(u.group);
      units.push(u);
    }
    for (const cfg of lv.cfg.acs.filter((a) => room.ids.includes(a.room))) {
      const u = new ACUnit(cfg);
      u.kind = 'ac';
      lv.group.add(u.group);
      units.push(u);
    }
  }

  /* ---------- picking ---------- */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  function pick(ev) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const targets = [...units.map((u) => u.hit), ...topVisible().flatMap((l) => l.floors)];
    const hits = raycaster.intersectObjects(targets, false);
    if (!hits.length) return null;
    const device = hits.find((h) => h.object.userData.kind !== 'room');
    const hit = (device || hits[0]).object.userData;
    if (hit.kind !== 'room') return { ...hit, cfg: units.find((u) => u.id === hit.id)?.cfg };
    return hit;
  }

  const fingers = new Map();
  let pinch = null;
  let drag = null;
  let press = null;
  const spread = () => {
    const [a, b] = [...fingers.values()];
    return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
  };

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.setPointerCapture(ev.pointerId);
    fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    clearTimeout(press?.timer);
    if (fingers.size === 2) { pinch = { spread: spread(), zoom: rig.zoom }; drag = null; press = null; return; }
    if (fingers.size > 2) return;
    drag = { x: ev.clientX, y: ev.clientY, az: rig.goal.az, el: rig.goal.el, moved: false };
    const t = pick(ev);
    press = t && t.kind !== 'room' ? {
      t, fired: false,
      timer: setTimeout(() => { if (drag && !drag.moved) { press.fired = true; onLongPress(t); } }, LONG_PRESS_MS),
    } : null;
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (fingers.has(ev.pointerId)) fingers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (pinch) {
      if (fingers.size >= 2) { rig.zoom = clamp(pinch.zoom * pinch.spread / spread(), ZOOM_MIN, ZOOM_MAX); frameGoal(); wake(); }
      return;
    }
    if (!drag) return;
    const dx = ev.clientX - drag.x;
    const dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 6) { drag.moved = true; clearTimeout(press?.timer); }
    if (drag.moved) {
      rig.goal.az = drag.az - dx * 0.35; // orbit all the way round
      rig.goal.el = clamp(drag.el + dy * 0.3, EL_MIN, EL_MAX);
      frameGoal();
      wake();
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    fingers.delete(ev.pointerId);
    clearTimeout(press?.timer);
    if (pinch) { if (!fingers.size) pinch = null; return; }
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved || press?.fired) { press = null; return; }
    press = null;
    const t = pick(ev);
    if (t?.kind === 'light') units.find((u) => u.id === t.id)?.bump();
    onPick(t);
    wake();
  });
  canvas.addEventListener('pointercancel', (ev) => {
    fingers.delete(ev.pointerId);
    clearTimeout(press?.timer);
    if (!fingers.size) pinch = null;
    drag = null;
  });
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    rig.zoom = clamp(rig.zoom * Math.exp(ev.deltaY * 0.0015), ZOOM_MIN, ZOOM_MAX);
    frameGoal();
    wake();
  }, { passive: false });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());

  /* ---------- loop: render on demand ---------- */

  let raf = 0;
  let last = 0;
  let awake = 0;
  let running = false;
  let shadowFrames = 3;

  function wake(frames = 2) {
    awake = Math.max(awake, frames);
    if (running && !raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }

  // Idle showcase (wall tablet): a slow orbit, rendered at ~15 fps to stay cool.
  let orbit = false;
  const ORBIT_DEG_PER_S = 360 / 240;

  function frame(now) {
    raf = 0;
    if (orbit && awake === 0 && now - last < 66) { raf = requestAnimationFrame(frame); return; }
    const dt = Math.min(0.07, (now - last) / 1000);
    last = now;
    if (orbit) rig.goal.az += dt * ORBIT_DEG_PER_S;
    const moving = updateRig(dt) || orbit;
    let active = moving;
    for (const u of units) active = u.update(dt) || active;
    if (shadowFrames > 0) { renderer.shadowMap.needsUpdate = true; shadowFrames--; active = true; }
    if (active || awake > 0) {
      composer.render(dt);
      awake = Math.max(0, awake - 1);
      if (moving || awake === 0) onMove?.();
    }
    if (running && (active || awake > 0)) raf = requestAnimationFrame(frame);
  }

  function resize() {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    width = r.width;
    height = r.height;
    const pr = Math.min(window.devicePixelRatio || 1, 1.75);
    renderer.setPixelRatio(pr);
    renderer.setSize(width, height, false);
    composer.setPixelRatio(pr);
    composer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    frameGoal();
    wake(3);
  }

  applyVisibility();
  resize();
  updateRig(0, true);
  if (intro) {
    // First load: start high and swung round, then ease down into the view.
    rig.az = rig.goal.az - 50;
    rig.el = Math.min(EL_MAX, rig.goal.el + 22);
    rig.dist = rig.goal.dist * 1.7;
    updateRig(0, true);
  }

  return {
    get room() { return room; },
    get peel() { return peel; },

    setPeel(levelId) {
      peel = levelId;
      applyVisibility();
      rig.zoom = 1;
      frameGoal();
      wake();
    },

    focusRoom(next) {
      room = next && roomOf(next.level, next.id)
        ? { ...next, ids: roomGroup(levelOf(next.level).cfg, next.id).map((r) => r.id) } : null;
      buildUnits();
      applyVisibility();
      rig.zoom = 1;
      rig.goal.el = room ? Math.max(plan.camera.elevation, 50) : plan.camera.elevation;
      frameGoal();
      wake(4);
    },

    /** HA's sun.sun elevation/azimuth (degrees). */
    setSun(elevation, azimuth) {
      if (!sky.update({ elevation, azimuth, dim: Boolean(room) })) return;
      glows.setDaylight(sky.daylight);
      shadowFrames = 3;
      wake();
    },

    // state(cfg) → { on, brightness, temp, color } for every lamp's house-view glow.
    applyGlows(state) {
      glows.apply(state);
      wake();
    },

    glowEntities: () => glows.entities(),

    /** Entities behind the model's live details: contact sensors on openings, TVs. */
    liveEntities: () => [...new Set(levels.flatMap((l) => [...l.alerts.map((a) => a.sensor), ...l.screens.map((x) => x.entity)]))],

    /** stateOf(entity) → HA state object; open openings glow red, playing TVs light up. */
    applyLive(stateOf) {
      for (const l of levels) {
        for (const a of l.alerts) a.mesh.visible = stateOf(a.sensor)?.state === 'on';
        for (const x of l.screens) {
          const st = stateOf(x.entity)?.state;
          const on = st && !['off', 'unavailable', 'unknown', 'standby'].includes(st);
          x.material.emissive.set(on ? '#7fb2ff' : '#27407a');
          x.material.emissiveIntensity = on ? 1.6 : 0.35;
        }
      }
      wake();
    },

    // state(kind, cfg) → the unit's state; called on every hass update.
    applyStates(state, { instant = false } = {}) {
      for (const u of units) u.apply(state(u.kind, u.cfg), { instant });
      wake();
    },

    // Screen positions of room labels: the top visible storey's rooms, plus the garden.
    // One label per area, on its biggest rect.
    labels() {
      const vis = topVisible();
      const top = vis[vis.length - 1];
      const out = [];
      camera.updateMatrixWorld();
      for (const l of vis) {
        const seen = new Set();
        const rooms = [...l.cfg.rooms].sort((a, b) => b.w * b.d - a.w * a.d);
        for (const r of rooms) {
          if (r.area && seen.has(r.area)) continue;
          if (r.area) seen.add(r.area);
          if (l !== top && !r.outdoor) continue;
          if (room && !room.ids.includes(r.id)) continue;
          v.set(r.x + r.w / 2, l.cfg.elevation + (room ? H * 0.9 : 0.05), r.z + r.d / 2).project(camera);
          if (v.z > 1) continue;
          out.push({ id: r.id, level: l.cfg.id, name: r.name, x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height });
        }
      }
      return out;
    },

    setIdleOrbit(on) {
      if (orbit === on) return;
      orbit = on;
      if (on) wake();
    },

    /** Screen position of a world point, or null when it is behind the camera. */
    project([x, y, z]) {
      camera.updateMatrixWorld();
      v.set(x, y, z).project(camera);
      if (v.z > 1) return null;
      return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height };
    },

    acView(id) {
      const u = units.find((x) => x.id === id && x.kind === 'ac');
      if (u) { rig.goal.az = baseAz + (WALL_SIDE[u.cfg.wall] ?? 0); frameGoal(); wake(); }
    },

    resize,

    setRunning(on) {
      running = on;
      if (on) wake(4);
      else if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },

    dispose() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      clearUnits();
      composer.dispose();
      target.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
