// A straight flight of stairs for the furniture library: `steps` treads rising `rise` metres
// over `length`, `width` wide, climbing towards -z (the back); `rot` turns it like any piece.
// `y` (on the item) lifts its foot, e.g. a second flight starting from a landing.
import * as THREE from 'three';
import { box, mat, at } from './kit.js';

export function stairs({ width = 1, length = 2.4, rise = 1.4, steps = 8, color = '#8a6a4f', rail: withRail = true }) {
  const g = new THREE.Group();
  const tread = length / steps;
  const step = rise / steps;
  const wood = mat(color, { rough: 0.7 });
  const nose = mat('#2c2620', { rough: 0.6 });
  for (let i = 0; i < steps; i++) {
    const h = step * (i + 1);
    const z = length / 2 - tread * (i + 0.5);
    g.add(at(box(width, h, tread, wood, { r: 0.008 }), 0, 0, z));
    g.add(at(box(width, 0.015, 0.03, nose, { r: 0 }), 0, h, z + tread / 2 - 0.015));
  }
  if (!withRail) return g;
  // a slim handrail on one side
  const rail = mat('#3a3f4c', { rough: 0.4, metal: 0.6 });
  const len = Math.hypot(length, rise);
  const bar = box(0.04, 0.04, len, rail, { r: 0.01 });
  bar.geometry.translate(0, -0.02, 0);
  bar.position.set(width / 2 - 0.03, rise / 2 + 0.9, 0);
  bar.rotation.x = Math.atan2(rise, length);
  g.add(bar);
  return g;
}

export const stairsFootprint = (item) => [item.width || 1, item.length || 2.4];
