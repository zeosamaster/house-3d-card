// Garden, deck and pool props for the furniture library: trees, hedges, bushes, a sun lounger,
// a parasol, a kettle grill, an outdoor sofa, a bench and a raised flowerbed. Same contract as
// every builder: a Group standing on y = 0, centred on its footprint, facing +z.
// Foliage is faceted (jittered icosahedrons, one normal per face), darker low down and lighter
// on top, so it reads as a crown in daylight and still has shape under the moon.
import * as THREE from 'three';
import { box, cyl, mat, at, rng } from './kit.js';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const group = (...children) => {
  const g = new THREE.Group();
  g.add(...children.flat().filter(Boolean));
  return g;
};

const TEAK = '#a8784b';
const TEAK_DARK = '#7a5435';
const CUSHION = '#efeadf';
const LEAF = { rough: 0.88 };
const leaf = (color) => mat(color, LEAF);

// Parasol cloth and palm fronds are single sheets, seen from above and below.
const sheets = new Map();
function sheet(color) {
  if (!sheets.has(color)) sheets.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.9, side: THREE.DoubleSide }));
  return sheets.get(color);
}

// Unless the plan pins a `seed`, vary each piece by where it stands, so a row of trees isn't a row of clones.
const seedOf = (item) => item.seed ?? Math.round((item.pos?.[0] ?? 0) * 733 + (item.pos?.[1] ?? 0) * 1601) + 1;

// shades[] runs dark → light; t in 0..1 picks along it, with a little noise.
function pick(shades, t, rand) {
  const i = Math.round(t * (shades.length - 1) + (rand() - 0.5) * 0.9);
  return shades[Math.max(0, Math.min(shades.length - 1, i))];
}

// Move every corner with move(p) (corners shared by several faces move together, so the shell
// stays closed) and give each face its own normal: the low-poly faceted look.
function facet(geo, move) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const pos = g.attributes.position;
  const p = V();
  const moved = new Map();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const key = `${Math.round(p.x * 1e3)},${Math.round(p.y * 1e3)},${Math.round(p.z * 1e3)}`;
    if (!moved.has(key)) moved.set(key, move(p.clone()));
    pos.setXYZ(i, ...moved.get(key).toArray());
  }
  g.computeVertexNormals();
  return g;
}

const jittered = (rand, jitter) => (p) => p.multiplyScalar(1 + (rand() - 0.5) * jitter);

function lump(r, material, rand, { detail = 1, jitter = 0.3 } = {}) {
  return new THREE.Mesh(facet(new THREE.IcosahedronGeometry(r, detail), jittered(rand, jitter)), material);
}

// A tapered cylinder from point a to point b (trunks, branches, struts).
function limb(a, b, r0, r1, material, seg = 7) {
  const len = a.distanceTo(b);
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg, 1);
  geo.translate(0, len / 2, 0);
  const m = new THREE.Mesh(geo, material);
  m.position.copy(a);
  m.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  return m;
}

// A rounded crown of lumps around (0, y, 0): rx across, ry tall, top lumps lighter than the
// underside. A core lump fills the middle so no sky shows through.
function crown(rand, shades, { y, rx, ry, n = 9, size = 0.5, squash = 0.85 }) {
  const core = lump(rx * 0.62, leaf(shades[1]), rand);
  core.position.y = y;
  core.scale.y = ry / rx;
  const out = [core];
  for (let i = 0; i < n; i++) {
    const h = 0.85 - (1.45 * (i + 0.5)) / n; // golden spiral from the top, stopping short of the underside
    const ring = Math.sqrt(1 - h * h);
    const a = i * 2.4 + rand() * 0.6;
    const s = rx * size * (0.8 + rand() * 0.4);
    const reach = rx - s * 0.85;
    const m = lump(s, leaf(pick(shades, (h + 0.6) / 1.45, rand)), rand);
    m.position.set(Math.cos(a) * ring * reach, y + h * (ry - s * squash * 0.85), Math.sin(a) * ring * reach);
    m.scale.y = squash;
    m.rotation.y = rand() * 6;
    out.push(m);
  }
  return out;
}

// A palm frond: a V-folded strip arching out along +x and drooping; the zig-zag edge reads as leaflets.
function frond(len, width, pitch, droop, material, segs = 9) {
  const ridge = [];
  const p = V();
  for (let i = 0; i <= segs; i++) {
    ridge.push(p.clone());
    const ang = pitch - droop * (i / segs) ** 2;
    p.add(V(Math.cos(ang), Math.sin(ang), 0).multiplyScalar(len / segs));
  }
  const edge = (i, side) => {
    const w = width * Math.sin(Math.PI * (0.1 + (0.9 * i) / segs)) * (i % 2 ? 0.5 : 1);
    return ridge[i].clone().add(V(0, -w * 0.45, side * w)).toArray();
  };
  const v = [];
  for (let i = 0; i < segs; i++) {
    for (const s of [-1, 1]) {
      const [a, b] = [ridge[i].toArray(), ridge[i + 1].toArray()];
      v.push(...a, ...edge(i, s), ...b, ...edge(i, s), ...edge(i + 1, s), ...b);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, material);
}

/* ---------- trees ---------- */

// Canopy diameter ÷ height, per kind (shared with the footprint).
const SPREAD = { round: 0.64, pine: 0.46, olive: 0.78, palm: 0.8 };

const TREES = {
  round(h, R, rand) {
    const bark = mat('#6f5644', { rough: 0.95 });
    const y = h - R * 0.8;
    const parts = [limb(V(), V(0, y, 0), h * 0.028, h * 0.014, bark)];
    for (let i = 0; i < 3; i++) {
      const a = i * 2.1 + rand();
      parts.push(limb(V(0, h * 0.36, 0), V(Math.cos(a) * R * 0.45, y + R * 0.1, Math.sin(a) * R * 0.45), h * 0.013, h * 0.007, bark));
    }
    return group(parts, crown(rand, ['#2c5927', '#386c30', '#47813a', '#5b9744'], { y, rx: R, ry: R * 0.8 }));
  },

  // Conifer: stacked, jittered cones on a straight trunk.
  pine(h, R, rand) {
    const parts = [limb(V(), V(0, h * 0.6, 0), h * 0.022, h * 0.01, mat('#6a4834', { rough: 0.95 }))];
    const shades = ['#305f3e', '#386c46', '#417a4f', '#4c8859'];
    for (let k = 0; k < 4; k++) {
      const f = k / 3;
      const ch = h * (0.36 - f * 0.1);
      const geo = facet(new THREE.ConeGeometry(R * (1 - f * 0.62), ch, 10, 2), jittered(rand, 0.24));
      geo.translate(0, ch / 2, 0);
      const m = at(new THREE.Mesh(geo, leaf(shades[k])), 0, h * (0.16 + f * 0.58), 0);
      m.rotation.set((rand() - 0.5) * 0.08, rand() * 6, (rand() - 0.5) * 0.08);
      parts.push(m);
    }
    return group(parts);
  },

  // Olive: a short, knotted, leaning trunk forking into a wide, open, silver-green crown.
  olive(h, R, rand) {
    const bark = mat('#7e6f60', { rough: 1 });
    const j = () => (rand() - 0.5) * h * 0.1;
    const p1 = V(j(), h * 0.15, j());
    const p2 = V(j(), h * 0.3, j());
    const parts = [
      limb(V(), p1, h * 0.052, h * 0.04, bark), limb(p1, p2, h * 0.042, h * 0.032, bark),
      at(lump(h * 0.05, bark, rand, { detail: 0, jitter: 0.5 }), p1.x, p1.y, p1.z),
      at(lump(h * 0.04, bark, rand, { detail: 0, jitter: 0.5 }), p2.x, p2.y, p2.z),
    ];
    const shades = ['#56683f', '#68794b', '#7b8c5a', '#90a06c', '#a5b283'];
    // many small tufts on a low dome: an open, airy crown rather than one solid ball
    const n = 15;
    for (let i = 0; i < n; i++) {
      const a = i * 2.4 + rand() * 0.5;
      const f = Math.sqrt((i + 0.5) / n);
      const s = R * (0.2 + rand() * 0.1);
      const d = (R - s) * f;
      const y = h * (0.62 + 0.2 * (1 - f * f)) + (rand() - 0.5) * h * 0.06;
      if (i % 3 === 1) parts.push(limb(p2, V(Math.cos(a) * d * 0.85, y - s * 0.4, Math.sin(a) * d * 0.85), h * 0.02, h * 0.01, bark));
      const m = at(lump(s, leaf(pick(shades, (y / h - 0.58) / 0.26, rand)), rand), Math.cos(a) * d, y, Math.sin(a) * d);
      m.scale.y = 0.7;
      m.rotation.y = rand() * 6;
      parts.push(m);
    }
    return group(parts);
  },

  // Palm: a ringed trunk curving off to one side, a fan of drooping fronds and a few coconuts.
  palm(h, R, rand) {
    const a = rand() * Math.PI * 2;
    const lean = V(Math.cos(a), 0, Math.sin(a));
    const spine = (t) => V(0, t * h * 0.84, 0).addScaledVector(lean, h * 0.12 * t * t);
    const barks = [mat('#8d7b62', { rough: 1 }), mat('#817058', { rough: 1 })];
    const parts = [];
    const N = 10;
    for (let i = 0; i < N; i++) {
      const r = h * 0.04 * (1 - (0.3 * i) / N);
      parts.push(limb(spine(i / N), spine((i + 1) / N), i ? r : r * 1.4, r * 0.88, barks[i % 2], 7));
    }
    const c = spine(1);
    parts.push(at(lump(h * 0.045, leaf('#62643a'), rand, { detail: 0 }), c.x, c.y, c.z));
    const fronds = 11;
    for (let k = 0; k < fronds; k++) {
      const f = frond(R * 1.2, h * 0.055, 0.6 - rand() * 0.7, 1.4 + rand() * 0.6, sheet(['#3c7a33', '#4a8a3b', '#58963f'][k % 3]));
      f.position.copy(c);
      f.rotation.set(0, (k / fronds) * Math.PI * 2 + rand() * 0.3, (rand() - 0.5) * 0.15);
      parts.push(f);
    }
    for (let k = 0; k < 3; k++) {
      parts.push(at(lump(h * 0.022, mat('#5f4229', { rough: 0.8 }), rand, { detail: 0, jitter: 0.15 }),
        c.x + Math.cos(k * 2.1) * h * 0.035, c.y - h * 0.03, c.z + Math.sin(k * 2.1) * h * 0.035));
    }
    return group(parts);
  },
};

export function tree(item) {
  const { height = 4.5, kind = 'round' } = item;
  const k = TREES[kind] ? kind : 'round';
  const crownAndTrunk = TREES[k](height, (SPREAD[k] * height) / 2, rng(seedOf(item)));
  crownAndTrunk.userData.sway = true; // rocks about its foot in the wind (life.js)
  return group(crownAndTrunk);
}

export function treeFootprint({ height = 4.5, kind }) {
  const s = (SPREAD[kind] || SPREAD.round) * height;
  return [s, s];
}

/* ---------- shrubs ---------- */

// A clipped hedge: one finely divided block with rounded top edges, every corner nudged in or
// out so it reads as trimmed foliage; the top is a lighter green than the sides.
export function hedge(item) {
  const { width: w = 3, height: h = 1, depth: d = 0.6 } = item;
  const rand = rng(seedOf(item));
  const step = 0.16;
  const r = Math.min(h, d) * 0.3;
  const inner = V(w / 2 - r, h / 2 - r, d / 2 - r);
  const clamp = THREE.MathUtils.clamp;
  const geo = facet(new THREE.BoxGeometry(w, h, d, Math.ceil(w / step), Math.ceil(h / step), Math.ceil(d / step)), (p) => {
    // round the edges (not the bottom, which sits on the ground), then roughen
    const c = V(clamp(p.x, -inner.x, inner.x), Math.min(p.y, inner.y), clamp(p.z, -inner.z, inner.z));
    const n = p.clone().sub(c);
    const len = n.length();
    if (len > 1e-6) n.divideScalar(len);
    const q = c.addScaledVector(n, Math.min(len, r));
    if (p.y < -h / 2 + 1e-3) return q;
    return q.add(V(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.05)).addScaledVector(n, (rand() - 0.5) * 0.07);
  });
  geo.translate(0, h / 2, 0);
  const side = leaf('#386a31');
  // BoxGeometry face groups: +x, -x, +y, -y, +z, -z
  return group(new THREE.Mesh(geo, [side, side, leaf('#4f8a3e'), side, side, side]));
}

// A round shrub, optionally dotted with `color` flowers.
export function bush(item) {
  const { size: s = 0.8, color } = item;
  const rand = rng(seedOf(item));
  const shades = ['#33622c', '#3f7535', '#4c873e', '#5d9a48'];
  const blobs = [[0, s * 0.42, 0, s * 0.34]];
  for (let i = 0; i < 4; i++) {
    const a = i * 1.57 + rand() * 0.8;
    blobs.push([Math.cos(a) * s * 0.22, s * (0.2 + rand() * 0.06), Math.sin(a) * s * 0.22, s * (0.23 + rand() * 0.06)]);
  }
  const parts = blobs.map(([x, y, z, r]) => {
    const m = at(lump(r, leaf(pick(shades, y / (s * 0.42), rand)), rand), x, y, z);
    m.scale.y = 0.85;
    return m;
  });
  if (color) {
    const petal = mat(color, { rough: 0.6 });
    const geo = new THREE.OctahedronGeometry(s * 0.04);
    for (let i = 0; i < 20; i++) {
      const [x, y, z, r] = blobs[i % blobs.length];
      // outwards from the bush's centre, never underneath
      const dir = V(x + (rand() - 0.5) * s * 0.4, s * (0.1 + rand() * 0.3), z + (rand() - 0.5) * s * 0.4).normalize();
      parts.push(at(new THREE.Mesh(geo, petal), x + dir.x * r * 0.97, y + dir.y * r * 0.85, z + dir.z * r * 0.97));
    }
  }
  return group(parts);
}

/* ---------- deck & pool furniture ---------- */

// Pool lounger: teak frame on wheels, a cushion, the backrest raised at the -z end.
export function sunbed({ color = CUSHION }) {
  const L = 1.95;
  const W = 0.7;
  const top = 0.3;
  const back = 0.72; // backrest length; it hinges up from z = hinge
  const hinge = -L / 2 + back;
  const teak = mat(TEAK, { rough: 0.7 });
  const frame = mat(TEAK_DARK, { rough: 0.75 });
  const pad = mat(color, { rough: 0.95 });
  const parts = [
    at(box(W - 0.06, 0.025, L - 0.06, teak, { r: 0 }), 0, top - 0.06, 0),
    at(box(W - 0.1, 0.075, L / 2 - hinge - 0.04, pad, { r: 0.03 }), 0, top - 0.035, (L / 2 + hinge) / 2),
    at(box(W, 0.07, 0.05, frame, { r: 0 }), 0, top - 0.12, L / 2 - 0.025),
  ];
  const wheel = new THREE.CylinderGeometry(0.075, 0.075, 0.04, 14);
  wheel.rotateZ(Math.PI / 2);
  for (const sx of [-1, 1]) {
    const x = sx * (W / 2 - 0.025);
    parts.push(
      at(box(0.05, 0.09, L, frame, { r: 0 }), x, top - 0.12, 0),
      at(box(0.05, top - 0.12, 0.05, frame, { r: 0 }), x, 0, L / 2 - 0.08),
      at(box(0.05, top - 0.12, 0.05, frame, { r: 0 }), x, 0, -L / 2 + 0.25),
      at(new THREE.Mesh(wheel, mat('#55585e', { rough: 0.6 })), sx * (W / 2 + 0.01), 0.075, -L / 2 + 0.12),
    );
  }
  const rest = group(
    at(box(W - 0.06, 0.025, back, teak, { r: 0 }), 0, -0.025, -back / 2),
    at(box(W - 0.1, 0.075, back - 0.05, pad, { r: 0.03 }), 0, 0, -back / 2),
    at(box(W - 0.24, 0.08, 0.22, pad, { r: 0.035 }), 0, 0.07, -back + 0.17),
  );
  const tilt = 0.85;
  rest.position.set(0, top - 0.035, hinge);
  rest.rotation.x = tilt;
  parts.push(rest);
  // struts propping the backrest
  const under = V(0, top - 0.06 + back * 0.6 * Math.sin(tilt), hinge - back * 0.6 * Math.cos(tilt));
  for (const sx of [-1, 1]) parts.push(limb(V(sx * (W / 2 - 0.08), top - 0.12, under.z - 0.18), under.clone().setX(sx * (W / 2 - 0.08)), 0.014, 0.014, frame, 6));
  return group(parts);
}

// Market parasol: weighted base, teak pole, ribs and an octagonal cloth canopy with a valance.
export function parasol({ size = 2.5, color = '#f0e6d2' }) {
  const R = size / 2;
  const apex = 2.62;
  const rim = apex - R * 0.36;
  const cloth = sheet(color);
  const wood = mat(TEAK, { rough: 0.6 });
  const canopy = at(new THREE.Mesh(new THREE.ConeGeometry(R, apex - rim, 8, 1, true), cloth), 0, (apex + rim) / 2, 0);
  const valance = at(new THREE.Mesh(new THREE.CylinderGeometry(R, R, 0.1, 8, 1, true), cloth), 0, rim - 0.05, 0);
  const parts = [
    at(cyl(0.26, 0.3, 0.07, mat('#8d8f93', { rough: 0.8 }), 20), 0, 0, 0),
    at(cyl(0.024, 0.026, apex, wood, 10), 0, 0, 0),
    at(cyl(0.045, 0.045, 0.1, wood, 10), 0, 1.92, 0),
    at(new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 6), wood), 0, apex + 0.02, 0),
    canopy, valance,
  ];
  const hub = V(0, apex - 0.04, 0);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const tip = V(Math.sin(a) * R * 0.97, rim - 0.02, Math.cos(a) * R * 0.97);
    parts.push(limb(hub, tip, 0.009, 0.007, wood, 4), limb(V(0, 2.0, 0), hub.clone().lerp(tip, 0.55), 0.007, 0.007, wood, 4));
  }
  return group(parts);
}

// Kettle barbecue: enamelled bowl and domed lid on three legs, a rack, two wheels at the back.
export function grill({ color = '#4b5059' }) {
  const r = 0.29;
  const y = 0.74;
  const enamel = mat(color, { rough: 0.45 });
  const steel = mat('#a7acb3', { rough: 0.35, metal: 0.7 });
  const grip = mat(TEAK_DARK, { rough: 0.6 });
  const bowl = at(new THREE.Mesh(new THREE.SphereGeometry(r, 22, 8, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), enamel), 0, y, 0);
  const lid = at(new THREE.Mesh(new THREE.SphereGeometry(r * 1.015, 22, 8, 0, Math.PI * 2, 0, Math.PI / 2), enamel), 0, y + 0.006, 0);
  lid.scale.y = 0.9;
  const band = at(new THREE.Mesh(new THREE.TorusGeometry(r * 1.02, 0.012, 6, 28), steel), 0, y + 0.004, 0);
  band.rotation.x = Math.PI / 2;
  const lidTop = y + r * 1.015 * 0.9;
  const parts = [
    bowl, lid, band,
    at(cyl(0.045, 0.045, 0.015, steel, 12), 0, lidTop - 0.006, 0),
    at(cyl(0.012, 0.012, 0.05, steel, 6), -0.06, lidTop - 0.01, 0.1),
    at(cyl(0.012, 0.012, 0.05, steel, 6), 0.06, lidTop - 0.01, 0.1),
    at(box(0.18, 0.03, 0.04, grip, { r: 0 }), 0, lidTop + 0.035, 0.1),
    at(cyl(0.1, 0.085, 0.05, steel, 14), 0, y - r - 0.06, 0),
  ];
  for (const sx of [-1, 1]) parts.push(at(box(0.04, 0.03, 0.15, grip, { r: 0 }), sx * (r + 0.03), y - 0.04, 0));
  // three legs, the rack's corners on them; wheels on the two back legs
  const rack = at(new THREE.Mesh(new THREE.CylinderGeometry(r * 0.88, r * 0.88, 0.012, 3), steel), 0, 0.26, 0);
  parts.push(rack);
  const wheel = new THREE.CylinderGeometry(0.07, 0.07, 0.035, 14);
  wheel.rotateZ(Math.PI / 2);
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2;
    const s = Math.sin(a);
    const c = Math.cos(a);
    parts.push(limb(V(s * r * 0.7, y - r * 0.7, c * r * 0.7), V(s * r * 1.05, 0, c * r * 1.05), 0.014, 0.014, steel, 6));
    if (k) parts.push(at(new THREE.Mesh(wheel, mat('#55585e', { rough: 0.6 })), s * r * 1.05 + Math.sign(s) * 0.03, 0.07, c * r * 1.05));
  }
  return group(parts);
}

// Low teak lounge sofa with thick outdoor cushions and two throw pillows.
export function outdoorSofa({ width: w = 2, color = CUSHION }) {
  const d = 0.85;
  const arm = 0.1;
  const inner = w - arm * 2;
  const teak = mat(TEAK, { rough: 0.65 });
  const fabric = mat(color, { rough: 0.95 });
  const parts = [
    at(box(w, 0.13, d, teak, { r: 0 }), 0, 0.07, 0),
    at(box(inner, 0.07, 0.04, teak, { r: 0 }), 0, 0.68, -d / 2 + 0.02),
  ];
  for (const y of [0.3, 0.48]) parts.push(at(box(inner, 0.07, 0.04, teak, { r: 0 }), 0, y, -d / 2 + 0.02));
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - arm / 2);
    parts.push(
      at(box(arm, 0.07, 0.07, teak, { r: 0 }), x, 0, d / 2 - 0.05), // feet
      at(box(arm, 0.07, 0.07, teak, { r: 0 }), x, 0, -d / 2 + 0.05),
      at(box(arm, 0.55, 0.06, teak, { r: 0 }), x, 0.2, d / 2 - 0.03), // front post
      at(box(arm, 0.55, 0.06, teak, { r: 0 }), x, 0.2, -d / 2 + 0.03),
      at(box(arm + 0.02, 0.035, d, teak, { r: 0 }), x, 0.75, 0), // armrest
    );
    for (const y of [0.32, 0.5]) parts.push(at(box(arm - 0.02, 0.07, d - 0.12, teak, { r: 0 }), x, y, 0));
  }
  const n = w >= 1.8 ? 3 : 2;
  const cw = inner / n;
  for (let i = 0; i < n; i++) {
    const x = -inner / 2 + cw * (i + 0.5);
    parts.push(at(box(cw - 0.015, 0.16, d - 0.2, fabric, { r: 0.05 }), x, 0.2, 0.08));
    const back = at(box(cw - 0.025, 0.46, 0.17, fabric, { r: 0.07 }), x, 0.3, -d / 2 + 0.14);
    back.rotation.x = -0.14;
    parts.push(back);
  }
  [['#3f7590', -1], ['#d6a046', 1]].forEach(([c, sx]) => {
    const p = at(box(0.36, 0.36, 0.12, mat(c, { rough: 1 }), { r: 0.05 }), sx * (inner / 2 - 0.25), 0.4, -d / 2 + 0.3);
    p.rotation.set(-0.3, sx * -0.25, sx * 0.08);
    parts.push(p);
  });
  return group(parts);
}

// Teak garden bench: slatted seat and back, armrests.
export function bench({ width: w = 1.6 }) {
  const teak = mat(TEAK, { rough: 0.7 });
  const seat = 0.44;
  const parts = [];
  for (const sx of [-1, 1]) {
    const x = sx * (w / 2 - 0.04);
    parts.push(
      at(box(0.06, 0.66, 0.06, teak, { r: 0 }), x, 0, 0.22),
      at(box(0.06, seat, 0.06, teak, { r: 0 }), x, 0, -0.22),
      at(box(0.07, 0.035, 0.54, teak, { r: 0.012 }), x, 0.66, 0),
      at(box(0.05, 0.06, 0.48, teak, { r: 0 }), x, seat - 0.09, 0),
      at(box(0.04, 0.04, 0.44, teak, { r: 0 }), x, 0.1, 0),
    );
  }
  for (let i = 0; i < 5; i++) parts.push(at(box(w - 0.1, 0.03, 0.075, teak, { r: 0 }), 0, seat - 0.03, 0.2 - i * 0.092));
  const back = group(
    at(box(0.06, 0.5, 0.05, teak, { r: 0 }), -(w / 2 - 0.04), 0, 0),
    at(box(0.06, 0.5, 0.05, teak, { r: 0 }), w / 2 - 0.04, 0, 0),
    ...[0.1, 0.23, 0.36].map((y) => at(box(w - 0.1, 0.08, 0.025, teak, { r: 0 }), 0, y, 0)),
  );
  back.position.set(0, seat - 0.02, -0.22);
  back.rotation.x = -0.14;
  parts.push(back);
  return group(parts);
}

// Raised timber planter, soil and a mixed planting: green mounds with flowers, a few lavender spikes.
export function flowerbed(item) {
  const { width: w = 2, depth: d = 0.8 } = item;
  const h = 0.4;
  const rand = rng(seedOf(item));
  const wood = mat('#93714f', { rough: 0.85 });
  const post = mat('#6f5139', { rough: 0.85 });
  const parts = [at(box(w - 0.06, 0.02, d - 0.06, mat('#4a3528', { rough: 1 }), { r: 0 }), 0, h - 0.07, 0)];
  for (const y of [0, h / 2]) {
    for (const s of [-1, 1]) {
      parts.push(at(box(w, h / 2 - 0.012, 0.035, wood, { r: 0 }), 0, y, s * (d / 2 - 0.018)));
      parts.push(at(box(0.035, h / 2 - 0.012, d - 0.07, wood, { r: 0 }), s * (w / 2 - 0.018), y, 0));
    }
  }
  for (const s of [-1, 1]) {
    parts.push(at(box(w + 0.03, 0.025, 0.07, post, { r: 0 }), 0, h - 0.01, s * (d / 2 - 0.02)));
    parts.push(at(box(0.07, 0.025, d + 0.03, post, { r: 0 }), s * (w / 2 - 0.02), h - 0.01, 0));
  }
  const greens = ['#355f2c', '#3f7134', '#4b823c', '#5a9446'];
  const blooms = ['#e8577a', '#f6f1e4', '#f3c94c', '#9a6bd8', '#ea6a3a', '#d23f5b'];
  const lavender = mat('#8a6cc9', { rough: 0.8 });
  const stem = mat('#5d7a46', { rough: 0.9 });
  const flower = new THREE.OctahedronGeometry(0.028);
  const cols = Math.max(2, Math.round(w / 0.22));
  const rows = Math.max(1, Math.round(d / 0.24));
  const soil = h - 0.05;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = -w / 2 + 0.1 + ((w - 0.2) * (i + 0.5 + (rand() - 0.5) * 0.5)) / cols;
      const z = -d / 2 + 0.1 + ((d - 0.2) * (j + 0.5 + (rand() - 0.5) * 0.5)) / rows;
      if (rand() < 0.18) {
        for (let k = 0; k < 4; k++) {
          const tip = V(x + (rand() - 0.5) * 0.1, soil + 0.2 + rand() * 0.08, z + (rand() - 0.5) * 0.1);
          parts.push(limb(V(x, soil, z), tip, 0.006, 0.005, stem, 4));
          const spike = at(lump(0.022, lavender, rand, { detail: 0, jitter: 0.2 }), tip.x, tip.y, tip.z);
          spike.scale.y = 2.6;
          parts.push(spike);
        }
        continue;
      }
      const r = 0.07 + rand() * 0.04;
      const mound = at(lump(r, leaf(pick(greens, rand(), rand)), rand, { detail: 0, jitter: 0.35 }), x, soil + r * 0.4, z);
      mound.scale.y = 0.8;
      mound.rotation.y = rand() * 6;
      parts.push(mound);
      const bloom = mat(blooms[Math.floor(rand() * blooms.length)], { rough: 0.6 });
      for (let k = 0; k < 4; k++) {
        const a = rand() * Math.PI * 2;
        const up = 0.4 + rand() * 0.6;
        const out = Math.sqrt(1 - up * up) * r;
        parts.push(at(new THREE.Mesh(flower, bloom), x + Math.cos(a) * out, soil + r * 0.4 + up * r * 0.85, z + Math.sin(a) * out));
      }
    }
  }
  return group(parts);
}
