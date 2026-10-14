// The house breathing: trees sway in the real wind, the pool's surface drifts, and rain falls
// on the garden (never through the roofless, cut-away rooms) while HA's weather says it rains.
import * as THREE from 'three';
import { floorMaterial } from './three/kit.js';

const TOP = 9;    // metres the rain falls from
const FALL = 11;  // m/s
const DROP = 0.55; // streak length
const DROPS = [0, 900, 2200]; // none / rain / pouring

export function createLife(scene, levels) {
  const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const sway = [];
  for (const l of levels) l.group.traverse((o) => { if (o.userData.sway) sway.push({ o, ph: Math.random() * 6.3 }); });
  const water = floorMaterial('water').map;

  // Rain lands on the outdoor zones of the ground storey, each weighted by its area.
  const ground = Math.min(...levels.map((l) => l.cfg.elevation));
  const zones = levels.filter((l) => l.cfg.elevation === ground).flatMap((l) => l.cfg.rooms.filter((r) => r.outdoor));
  const total = zones.reduce((s, r) => s + r.w * r.d, 0);

  let level = 0;
  let wind = 0;
  let shown = true;
  let rain = null;

  function place(pos, i, y) {
    let k = Math.random() * total;
    const r = zones.find((z) => (k -= z.w * z.d) <= 0) || zones[0];
    const x = r.x + Math.random() * r.w;
    const z = r.z + Math.random() * r.d;
    pos.set([x, y, z, x - wind * 0.3, y + DROP, z], i * 6);
  }

  function setRain(n) {
    if (rain) { scene.remove(rain.mesh); rain.mesh.geometry.dispose(); rain.mesh.material.dispose(); rain = null; }
    if (!n || !total) return;
    const pos = new Float32Array(n * 6);
    const mesh = new THREE.LineSegments(new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: '#c4d6ea', transparent: true, opacity: 0.42, depthWrite: false }));
    for (let i = 0; i < n; i++) place(pos, i, Math.random() * TOP);
    mesh.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    mesh.frustumCulled = false;
    mesh.raycast = () => {};
    mesh.visible = shown;
    scene.add(mesh);
    rain = { mesh, pos, n };
  }

  return {
    /** True while something moves on its own (rain): the stage keeps drawing frames. */
    get busy() { return Boolean(rain) && shown; },

    /** rain: 0 none, 1 rain, 2 pouring; wind: 0..1. Returns whether anything changed. */
    setWeather(nextRain, nextWind) {
      if (still) return false;
      const w = Math.round(nextWind * 20) / 20;
      if (nextRain === level && w === wind) return false;
      wind = w;
      if (nextRain !== level) { level = nextRain; setRain(DROPS[level]); }
      return true;
    },

    /** Rain only in the house view. */
    show(on) {
      shown = on;
      if (rain) rain.mesh.visible = on;
    },

    tick(dt) {
      if (still) return;
      const t = performance.now() / 1000;
      const amp = THREE.MathUtils.degToRad(0.5 + 2.2 * wind);
      for (const { o, ph } of sway) {
        o.rotation.x = amp * Math.sin(t * 1.6 + ph);
        o.rotation.z = amp * 0.6 * Math.sin(t * 1.1 + ph * 1.3);
      }
      water.offset.set((t * 0.012) % 1, Math.sin(t * 0.35) * 0.015);
      if (!rain || !shown) return;
      const { pos, n } = rain;
      const fall = FALL * dt;
      for (let i = 0; i < n; i++) {
        const y = pos[i * 6 + 1] - fall;
        if (y < 0) place(pos, i, y + TOP);
        else { pos[i * 6 + 1] = y; pos[i * 6 + 4] = y + DROP; }
      }
      rain.mesh.geometry.attributes.position.needsUpdate = true;
    },
  };
}
