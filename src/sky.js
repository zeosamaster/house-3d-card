// Sun, sky and moon from HA's sun.sun: the light comes from where the sun really is, the
// background is a sky gradient for that moment, and after dusk a soft moon takes over so the
// lamps carry the scene. `north` is the plan direction [x, z] that faces real north.
import * as THREE from 'three';

// elevation° → sky top, sky horizon, sun colour, sun intensity, ambient intensity
const KEYS = [
  [-90, '#04060d', '#090d19', '#9fb6ff', 0.5, 0.5],
  [-12, '#05070f', '#0e1428', '#9fb6ff', 0.5, 0.55], // night
  [-5, '#151a3c', '#3c3866', '#8a7cc0', 0.35, 0.75], // blue hour
  [0, '#2a3b6e', '#e3875a', '#ff9a5a', 0.9, 1.0], // sunset / sunrise
  [7, '#4b74bd', '#f1c18a', '#ffc68c', 2.0, 1.5], // golden hour
  [22, '#5a90d6', '#bdd8f2', '#fff0da', 2.8, 1.9], // day
  [90, '#4f8ad6', '#cfe4f7', '#ffffff', 3.0, 2.0],
];

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

function sample(elevation) {
  let i = 0;
  while (i < KEYS.length - 2 && elevation > KEYS[i + 1][0]) i++;
  const [e0, ...a] = KEYS[i];
  const [e1, ...b] = KEYS[i + 1];
  const t = Math.min(1, Math.max(0, (elevation - e0) / (e1 - e0)));
  const col = (p, q) => new THREE.Color(p).lerp(new THREE.Color(q), t);
  return { top: col(a[0], b[0]), horizon: col(a[1], b[1]), sun: col(a[2], b[2]),
    sunI: a[3] + (b[3] - a[3]) * t, ambI: a[4] + (b[4] - a[4]) * t };
}

export function createSky(scene, center, span) {
  const hemi = new THREE.HemisphereLight(0x8ea6ff, 0x0b0e17, 1);
  const sun = new THREE.DirectionalLight(0xffffff, 1);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = sc.bottom = -span * 0.75;
  sc.right = sc.top = span * 0.75;
  sc.near = 1;
  sc.far = span * 4;
  sun.shadow.bias = -0.0008;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 3; // softer edges
  sun.shadow.blurSamples = 12;
  sun.target.position.copy(center);
  scene.add(hemi, sun, sun.target);

  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 256;
  // Stars are painted into the sky texture, which matches the screen's aspect (setAspect) so
  // they stay round. (The camera looks down at the house and never sees a 3D sky dome.)
  const STARS = Array.from({ length: 380 }, (_, i) => {
    const r = (n) => { const x = Math.sin(i * 12.9898 + n * 78.233) * 43758.5453; return x - Math.floor(x); };
    return [r(1), r(2) * r(2), 0.6 + r(3) * 0.9, 0.35 + r(4) * 0.65]; // u, v (denser up top), size, alpha
  });
  let paint = null;
  const bg = new THREE.CanvasTexture(canvas);
  bg.colorSpace = THREE.SRGBColorSpace;
  scene.background = bg;

  function drawSky() {
    if (!paint) return;
    const g = canvas.getContext('2d');
    const { width: W, height: Hh } = canvas;
    const grad = g.createLinearGradient(0, 0, 0, Hh);
    grad.addColorStop(0, `#${paint.top.getHexString()}`);
    grad.addColorStop(1, `#${paint.horizon.getHexString()}`);
    g.fillStyle = grad;
    g.fillRect(0, 0, W, Hh);
    if (paint.stars > 0.02) {
      // all across the width; fewer of them on narrow screens
      for (const [u, v, size, a] of STARS.slice(0, Math.ceil(STARS.length * Math.min(1, W / 700)))) {
        g.fillStyle = `rgba(230, 236, 255, ${(a * paint.stars * (1 - v * 0.8)).toFixed(3)})`;
        g.beginPath();
        g.arc(u * W, v * Hh * 0.8, size * 0.5, 0, Math.PI * 2);
        g.fill();
      }
    }
    bg.needsUpdate = true;
  }

  let north = new THREE.Vector2(0, -1);
  let last = null;
  const sky = {
    elevation: -30,
    azimuth: 180,
    /** 0 at night, 1 in full day. */
    daylight: 0,

    setNorth([x, z]) { north = new THREE.Vector2(x, z).normalize(); last = null; },

    /** Viewport width / height: the sky texture takes the same shape so stars stay round. */
    setAspect(aspect) {
      const w = Math.round(Math.min(1024, Math.max(96, 384 * aspect)));
      if (w === canvas.width) return;
      canvas.width = w;
      canvas.height = 384;
      bg.dispose(); // re-upload at the new size
      drawSky();
    },

    /** Returns true when anything visible changed (the caller re-renders + redraws shadows). */
    cloud: 0,

    update({ elevation = sky.elevation, azimuth = sky.azimuth, dim = false, cloud = sky.cloud } = {}) {
      const key = `${elevation.toFixed(1)}|${azimuth.toFixed(1)}|${dim}|${cloud.toFixed(2)}`;
      if (key === last) return false;
      last = key;
      sky.elevation = elevation;
      sky.azimuth = azimuth;
      sky.cloud = cloud;
      sky.daylight = smooth(-6, 8, elevation);
      const s = sample(elevation);
      // Clouds: a greyer, flatter sky and a softer sun (shadows fade, ambient carries more).
      if (cloud > 0) {
        const grey = new THREE.Color('#8f98a6').multiplyScalar(0.35 + 0.65 * smooth(-6, 12, elevation));
        s.top.lerp(grey, cloud * 0.75);
        s.horizon.lerp(grey, cloud * 0.6);
        s.sunI *= 1 - 0.7 * cloud;
        s.ambI *= 1 + 0.15 * cloud;
      }

      // Direction to the light: the sun by day; at night a high moon opposite it, so shadows
      // still read and never come from below the ground.
      const night = elevation < -4;
      const az = THREE.MathUtils.degToRad(night ? azimuth + 180 : azimuth);
      const el = THREE.MathUtils.degToRad(night ? 55 : Math.max(elevation, 4));
      const east = new THREE.Vector2(-north.y, north.x); // north turned clockwise on the plan
      const h = Math.cos(el);
      const dx = (north.x * Math.cos(az) + east.x * Math.sin(az)) * h;
      const dz = (north.y * Math.cos(az) + east.y * Math.sin(az)) * h;
      sun.position.copy(center).add(new THREE.Vector3(dx, Math.sin(el), dz).multiplyScalar(span * 2));
      sun.color.copy(s.sun);
      // A room view dims the house at night so its lamps carry the scene; by day it stays bright.
      const dimBy = dim ? 1 - 0.45 * (1 - sky.daylight) : 1;
      sun.intensity = s.sunI * dimBy;
      hemi.intensity = s.ambI * dimBy;
      hemi.color.copy(s.horizon).lerp(new THREE.Color('#ffffff'), 0.35);
      hemi.groundColor.set(night ? '#0b0e17' : '#3a372e');

      paint = { top: s.top.clone(), horizon: s.horizon.clone(), stars: (1 - smooth(-12, -4, elevation)) * (1 - cloud * 0.9) };
      drawSky();
      return true;
    },
  };
  return sky;
}
