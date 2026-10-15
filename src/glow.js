// The whole-house view's lamps: a bright bulb (picked up by the bloom pass) and an additive
// pool of light on the floor under every lamp that is on, tinted and scaled by its live state.
// No real three.js lights — 47 of those would sink a phone. Lamps ease on (quicker) and off
// (slower) rather than pop, and on first load they come on one after another.
import * as THREE from 'three';
import { lightColor } from './three/lights.js';
import { roomGroup } from './plan.js';

let poolTexture;
function pool() {
  if (poolTexture) return poolTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  poolTexture = new THREE.CanvasTexture(c);
  return poolTexture;
}

// Bulb height and pool radius per fixture type (metres).
const SHAPE = {
  ceiling: (cfg, H) => [cfg.y ?? H - 0.2, 1.7],
  pendant: (cfg) => [(cfg.y ?? 1.8) - 0.05, 1.4],
  spots: (cfg, H) => [cfg.y ?? H - 0.2, 2.2],
  floor: (cfg) => [cfg.y ?? 1.35, 1.5],
  table: (cfg) => [(cfg.y ?? 0.5) + 0.25, 1.1],
  strip: (cfg) => [cfg.y ?? 1, 1.3],
};

export function createGlows(levels, H) {
  const all = [];
  for (const level of levels) {
    const outdoor = new Set(level.cfg.rooms.filter((r) => r.outdoor).map((r) => r.id));
    const group = new THREE.Group();
    level.group.add(group);
    for (const cfg of level.cfg.lights) {
      const [y, radius] = (SHAPE[cfg.type] || SHAPE.ceiling)(cfg, H);
      const bulb = new THREE.Mesh(new THREE.SphereGeometry(cfg.type === 'strip' ? 0.05 : 0.08, 12, 8),
        new THREE.MeshBasicMaterial({ toneMapped: false }));
      bulb.position.set(cfg.pos[0], y, cfg.pos[1]);
      const spot = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({ map: pool(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      spot.rotation.x = -Math.PI / 2;
      // Outdoor fixtures throw a wider pool; outdoors light also has no ceiling to stop it.
      const r = outdoor.has(cfg.room) ? radius * 1.5 : radius;
      spot.scale.setScalar(r * 2);
      spot.position.set(cfg.pos[0], 0.03, cfg.pos[1]);
      spot.renderOrder = 2;
      for (const m of [bulb, spot]) { m.visible = false; m.raycast = () => {}; group.add(m); }
      if (cfg.type === 'strip') bulb.scale.set(Math.max(1, (cfg.length ?? 1) / 0.1), 1, 1);
      bulb.rotation.y = THREE.MathUtils.degToRad(cfg.rot || 0);
      all.push({ cfg, bulb, spot, hidden: false, state: null, lit: null, k: 0, delay: 0 });
    }
  }

  const tmp = new THREE.Color();
  let daylight = 0;

  // Windows: for each room's glass, the lamps of its whole area (L-shaped rooms share).
  const panes = [];
  for (const level of levels) {
    for (const [roomId, material] of level.windows || []) {
      const ids = new Set(roomGroup(level.cfg, roomId).map((r) => r.id));
      panes.push({ material, lamps: all.filter((g) => ids.has(g.cfg.room)), base: material.emissive.clone(), baseI: material.emissiveIntensity, baseO: material.opacity });
    }
  }
  const warm = new THREE.Color('#ffb46a');
  function paintWindows() {
    for (const p of panes) {
      const on = p.lamps.filter((g) => g.k > 0.005 && g.lit);
      const level = on.length ? Math.max(...on.map((g) => g.k * (g.lit.brightness ?? 1))) : 0;
      const night = 1 - daylight;
      if (!level || night < 0.05) {
        p.material.emissive.copy(p.base);
        p.material.emissiveIntensity = p.baseI;
        p.material.opacity = p.baseO;
        continue;
      }
      // Warm, bright enough to bloom: a lit room seen from the garden at night.
      lightColor({ temp: 2900, ...on[0].lit }, tmp).lerp(warm, 0.4);
      p.material.emissive.copy(tmp);
      p.material.emissiveIntensity = (0.9 + 1.6 * level) * night + p.baseI * (1 - night);
      p.material.opacity = p.baseO + (0.55 - p.baseO) * night;
    }
  }

  const goal = (g) => (g.state?.on && !g.hidden ? 1 : 0);

  function paint(g) {
    const s = g.lit; // the last "on" state: a fading lamp keeps its colour
    const on = g.k > 0.005 && Boolean(s);
    g.bulb.visible = on;
    g.spot.visible = on;
    if (!on) return;
    const level = (s.brightness ?? 1) * g.k;
    lightColor({ temp: 3000, ...s }, tmp);
    // Hot enough to bloom at night; by day the bulb reads but the pool all but vanishes.
    g.bulb.material.color.copy(tmp).multiplyScalar(1.2 + 3 * level * (1 - 0.6 * daylight));
    g.spot.material.color.copy(tmp).multiplyScalar((0.25 + 0.55 * level) * (1 - 0.8 * daylight));
  }

  return {
    /** state(cfg) → { on, brightness, temp, color } */
    apply(state, { stagger = false } = {}) {
      let i = 0;
      for (const g of all) {
        g.state = state(g.cfg);
        if (g.state?.on) g.lit = g.state;
        if (stagger && g.state?.on) g.delay = 0.35 + 0.05 * i++;
        paint(g);
      }
      paintWindows();
    },
    /** Lamps shown by real lights instead (the focused room's): those switch at once. */
    hide(ids) {
      for (const g of all) {
        g.hidden = ids.has(g.cfg.id);
        if (g.hidden) g.k = 0;
        paint(g);
      }
      paintWindows();
    },
    /** Eases every lamp towards on/off; true while any is still changing. */
    update(dt) {
      let busy = false;
      for (const g of all) {
        const t = goal(g);
        if (g.k === t) continue;
        busy = true;
        if (g.delay > 0) { g.delay -= dt; continue; }
        g.k += (t - g.k) * (1 - Math.exp(-dt * (t > g.k ? 7 : 4)));
        if (Math.abs(t - g.k) < 0.01) g.k = t;
        paint(g);
      }
      if (busy) paintWindows();
      return busy;
    },
    setDaylight(d) {
      daylight = d;
      for (const g of all) paint(g);
      paintWindows();
    },
    entities() { return all.map((g) => g.cfg.entity).filter(Boolean); },
  };
}
