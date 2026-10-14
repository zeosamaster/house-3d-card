// Small modelling kit: cached materials, primitive helpers and procedural floor textures.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const materials = new Map();

export function mat(color, { rough = 0.85, metal = 0, emissive = null, emissiveIntensity = 1, opacity = 1 } = {}) {
  const key = [color, rough, metal, emissive, emissiveIntensity, opacity].join('|');
  let m = materials.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = emissiveIntensity; }
    if (opacity < 1) { m.transparent = true; m.opacity = opacity; }
    materials.set(key, m);
  }
  return m;
}

// Box standing on y = 0, centred on x/z.
export function box(w, h, d, material, { r = 0.02 } = {}) {
  const radius = Math.max(0, Math.min(r, Math.min(w, h, d) / 2 - 0.001));
  const geo = radius > 0.002 ? new RoundedBoxGeometry(w, h, d, 2, radius) : new THREE.BoxGeometry(w, h, d);
  geo.translate(0, h / 2, 0);
  return new THREE.Mesh(geo, material);
}

// Cylinder standing on y = 0.
export function cyl(rTop, rBottom, h, material, seg = 28) {
  const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg);
  geo.translate(0, h / 2, 0);
  return new THREE.Mesh(geo, material);
}

export function at(mesh, x = 0, y = 0, z = 0) {
  mesh.position.set(x, y, z);
  return mesh;
}

export function shadows(root, cast = true, receive = true) {
  root.traverse((o) => {
    if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; }
  });
  return root;
}

// Deterministic pseudo-random so a plan always renders identically.
export function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- floor textures ---------- */

const TILE = 2.4; // metres covered by one texture repeat

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

function shade(hex, amount) {
  const c = new THREE.Color(hex);
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s, Math.min(1, Math.max(0, hsl.l + amount)));
  return `#${c.getHexString()}`;
}

function planks(base) {
  return canvasTexture(1024, (g, s) => {
    const rand = rng(base.length * 97 + base.charCodeAt(3));
    const rows = 16;
    const rh = s / rows;
    for (let r = 0; r < rows; r++) {
      let x = -rand() * s * 0.5;
      while (x < s) {
        const len = s * (0.35 + rand() * 0.35);
        g.fillStyle = shade(base, (rand() - 0.5) * 0.09);
        g.fillRect(x, r * rh, len, rh);
        g.fillStyle = 'rgba(0,0,0,0.28)';
        g.fillRect(x, r * rh, 1.5, rh);
        // faint grain
        g.strokeStyle = 'rgba(0,0,0,0.05)';
        for (let k = 0; k < 3; k++) {
          const y = r * rh + rand() * rh;
          g.beginPath(); g.moveTo(x, y); g.lineTo(x + len, y + (rand() - 0.5) * 3); g.stroke();
        }
        x += len;
      }
      g.fillStyle = 'rgba(0,0,0,0.3)';
      g.fillRect(0, r * rh, s, 1.5);
    }
  });
}

function tiles(base, perSide, grout) {
  return canvasTexture(512, (g, s) => {
    const rand = rng(perSide * 31 + base.charCodeAt(2));
    const t = s / perSide;
    g.fillStyle = grout;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < perSide; i++) {
      for (let j = 0; j < perSide; j++) {
        g.fillStyle = shade(base, (rand() - 0.5) * 0.05);
        g.fillRect(i * t + 2, j * t + 2, t - 4, t - 4);
      }
    }
  });
}

function grass() {
  return canvasTexture(512, (g, s) => {
    const rand = rng(7);
    g.fillStyle = '#4f7a3a';
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = shade('#4f7a3a', (rand() - 0.5) * 0.12);
      g.fillRect(rand() * s, rand() * s, 2, 5);
    }
  });
}

function water() {
  return canvasTexture(256, (g, s) => {
    const rand = rng(3);
    g.fillStyle = '#2f8fc4';
    g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    for (let i = 0; i < 40; i++) {
      const x = rand() * s, y = rand() * s;
      g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 12, y - 4, x + 24, y); g.stroke();
    }
  });
}

const FLOORS = {
  oak: () => planks('#c7a47c'),
  walnut: () => planks('#94705a'),
  tile: () => tiles('#d5dade', 4, '#aab0b8'),
  stone: () => tiles('#a2a7ae', 3, '#7c828b'),
  // outdoor zones
  grass,
  deck: () => planks('#8a6f55'),
  paving: () => tiles('#b9b3a8', 2, '#8f8a80'),
  water,
};

export const FLOOR_KINDS = Object.keys(FLOORS);

const floorMaterials = new Map();

export function floorMaterial(kind) {
  const name = FLOORS[kind] ? kind : 'oak';
  if (!floorMaterials.has(name)) {
    floorMaterials.set(name, new THREE.MeshStandardMaterial({
      map: FLOORS[name](),
      roughness: name === 'water' ? 0.15 : name === 'tile' || name === 'stone' ? 0.55 : 0.75,
      ...(name === 'water' ? { emissive: new THREE.Color('#0d3b5c'), emissiveIntensity: 0.6 } : {}),
    }));
  }
  return floorMaterials.get(name);
}

// Floor quad whose UVs are in world metres, so every room shares one texture scale.
export function floorMesh(room, kind) {
  const geo = new THREE.PlaneGeometry(room.w, room.d);
  geo.rotateX(-Math.PI / 2);
  geo.translate(room.x + room.w / 2, 0, room.z + room.d / 2);
  const pos = geo.attributes.position;
  const uv = geo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i) / TILE, pos.getZ(i) / TILE);
  const mesh = new THREE.Mesh(geo, floorMaterial(kind));
  mesh.receiveShadow = true;
  return mesh;
}
