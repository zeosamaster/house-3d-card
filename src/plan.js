// The floor plan: storeys ("levels"), each with House Control's rooms / openings /
// furniture / lights / acs, plus links to HA areas and entities. Stored in the card config.

export const LIGHT_TYPES = ['ceiling', 'pendant', 'spots', 'floor', 'table', 'strip'];
export const WALLS = ['north', 'south', 'east', 'west'];
export const INDOOR_FLOORS = ['oak', 'walnut', 'tile', 'stone'];
export const OUTDOOR_FLOORS = ['grass', 'deck', 'paving', 'tile', 'stone', 'water', 'soil'];

export class PlanError extends Error {}

const need = (cond, msg) => { if (!cond) throw new PlanError(msg); };
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const SLAB = 0.25;

export function normalizePlan(raw) {
  need(raw && typeof raw === 'object', 'Plan must be an object');
  need(Array.isArray(raw.levels) && raw.levels.length > 0, 'Plan needs at least one entry in "levels"');
  const wallHeight = raw.wallHeight ?? 2.6;
  const interiorWallHeight = raw.interiorWallHeight ?? 1.25;
  const ids = new Set();
  const unique = (id, what) => {
    need(typeof id === 'string' && id, `${what} is missing an "id"`);
    need(!ids.has(id), `Duplicate id "${id}"`);
    ids.add(id);
  };

  const levels = raw.levels.map((lv, li) => {
    const where = `Level "${lv.name || lv.id || li + 1}"`;
    need(typeof lv.id === 'string' && lv.id, `Level #${li + 1} is missing an "id"`);
    const rooms = (lv.rooms || []).map((r) => {
      unique(r.id, `${where}: a room`);
      need(Array.isArray(r.rect) && r.rect.length === 4 && r.rect.every(Number.isFinite),
        `${where}: room "${r.id}" needs "rect": [x, z, width, depth]`);
      const [x, z, w, d] = r.rect;
      need(w > 0 && d > 0, `${where}: room "${r.id}" has an empty rect`);
      const rot = Number(r.rot) || 0;
      return {
        id: r.id, name: r.name || r.id, area: r.area || null, x, z, w, d, rot, ...aabb(x, z, w, d, rot),
        outdoor: Boolean(r.outdoor), floor: r.floor || (r.outdoor ? 'grass' : 'oak'),
        glow: r.glow || null, // a light whose colour tints this floor at night (e.g. the pool's water)
      };
    });
    const roomIds = new Set(rooms.map((r) => r.id));
    const openings = (lv.openings || []).map((o, i) => {
      need(isPoint(o.from) && isPoint(o.to), `${where}: opening #${i + 1} needs "from" and "to"`);
      need(o.from[0] === o.to[0] || o.from[1] === o.to[1], `${where}: opening #${i + 1} must be axis-aligned`);
      return { type: o.type || 'door', from: o.from, to: o.to, sill: o.sill ?? 0.85, head: o.head ?? 2.1, sensor: o.sensor || null };
    });
    const lights = (lv.lights || []).map((l, i) => {
      const id = l.id || l.entity || `${lv.id}.light${i + 1}`;
      unique(id, `${where}: a light`);
      need(roomIds.has(l.room), `${where}: light "${id}" is in unknown room "${l.room}"`);
      need(LIGHT_TYPES.includes(l.type), `${where}: light "${id}" has unknown type "${l.type}"`);
      need(isPoint(l.pos), `${where}: light "${id}" needs "pos": [x, z]`);
      return { ...l, id, name: l.name || id, rot: l.rot || 0, capabilities: l.capabilities || null };
    });
    const acs = (lv.acs || []).map((a, i) => {
      const id = a.id || a.entity || `${lv.id}.ac${i + 1}`;
      unique(id, `${where}: an AC`);
      need(roomIds.has(a.room), `${where}: AC "${id}" is in unknown room "${a.room}"`);
      need(isPoint(a.pos), `${where}: AC "${id}" needs "pos": [x, z]`);
      need(WALLS.includes(a.wall), `${where}: AC "${id}" needs "wall": one of ${WALLS.join(', ')}`);
      return { ...a, id, name: a.name || id, y: a.y ?? 2.2 };
    });
    return {
      id: lv.id, levelId: lv.id, name: lv.name || lv.id, floor: lv.floor || null,
      elevation: lv.elevation ?? li * (wallHeight + SLAB),
      wallHeight, interiorWallHeight, rooms, openings, furniture: lv.furniture || [], lights, acs,
      bounds: boundsOf(rooms),
    };
  });

  return {
    name: raw.name || 'Casa',
    revision: raw.revision || 0,
    wallHeight,
    interiorWallHeight,
    camera: { azimuth: raw.camera?.azimuth ?? 34, elevation: raw.camera?.elevation ?? 47 },
    // Plan direction [x, z] that faces real north (default: up the plan, -z).
    north: Array.isArray(raw.north) && raw.north.length === 2 && raw.north.some(Boolean) ? raw.north : [0, -1],
    levels,
    bounds: boundsOf(levels.flatMap((l) => l.rooms)),
  };
}

// Axis-aligned box of a room; a rotated room turns about its rect's centre.
function aabb(x, z, w, d, rot) {
  if (!rot) return { bx0: x, bz0: z, bx1: x + w, bz1: z + d };
  const a = (rot * Math.PI) / 180;
  const hw = Math.abs((w / 2) * Math.cos(a)) + Math.abs((d / 2) * Math.sin(a));
  const hd = Math.abs((w / 2) * Math.sin(a)) + Math.abs((d / 2) * Math.cos(a));
  const cx = x + w / 2;
  const cz = z + d / 2;
  return { bx0: cx - hw, bz0: cz - hd, bx1: cx + hw, bz1: cz + hd };
}

export function boundsOf(rooms) {
  if (!rooms.length) return { minX: 0, minZ: 0, maxX: 6, maxZ: 4 };
  return {
    minX: Math.min(...rooms.map((r) => r.bx0 ?? r.x)),
    minZ: Math.min(...rooms.map((r) => r.bz0 ?? r.z)),
    maxX: Math.max(...rooms.map((r) => r.bx1 ?? r.x + r.w)),
    maxZ: Math.max(...rooms.map((r) => r.bz1 ?? r.z + r.d)),
  };
}

// Rooms that share an HA area on a storey act as one room (L-shapes, split zones).
export function roomGroup(level, roomId) {
  const room = level.rooms.find((r) => r.id === roomId);
  if (!room) return [];
  return room.area ? level.rooms.filter((r) => r.area === room.area) : [room];
}

const OUTDOOR_FLOOR = /ext|outdoor|outside|garden|jardim|quintal/i;

// A first rough plan from HA's floors and areas: one storey per floor level, every area a
// 4 × 4 m room in a grid, areas on an "exterior"-looking floor as wall-less outdoor zones.
export function planFromAreas(hass) {
  const floors = Object.values(hass.floors || {}).sort((a, b) => (a.level ?? 0) - (b.level ?? 0));
  const areas = Object.values(hass.areas || {});
  const byLevel = new Map();
  for (const f of floors) {
    const n = f.level ?? 0;
    if (!byLevel.has(n)) byLevel.set(n, { id: f.floor_id, name: f.name, floor: f.floor_id, indoor: [], outdoor: [] });
    const lv = byLevel.get(n);
    const outdoor = OUTDOOR_FLOOR.test(`${f.floor_id} ${f.name}`);
    if (!outdoor && lv.floor !== f.floor_id && OUTDOOR_FLOOR.test(`${lv.floor} ${lv.name}`)) {
      // prefer the indoor floor as the storey's identity
      Object.assign(lv, { id: f.floor_id, name: f.name, floor: f.floor_id });
    }
    for (const a of areas.filter((x) => x.floor_id === f.floor_id)) (outdoor ? lv.outdoor : lv.indoor).push(a);
  }
  if (!byLevel.size) byLevel.set(0, { id: 'ground', name: 'Ground', floor: null, indoor: areas, outdoor: [] });

  const levels = [...byLevel.values()].map((lv) => {
    const rooms = [];
    const cols = Math.max(1, Math.ceil(Math.sqrt(lv.indoor.length)));
    lv.indoor.forEach((a, i) => rooms.push({
      id: a.area_id, name: a.name, area: a.area_id, rect: [(i % cols) * 4, Math.floor(i / cols) * 4, 4, 4], floor: 'oak',
    }));
    const below = Math.ceil(lv.indoor.length / cols) * 4 + 1;
    lv.outdoor.forEach((a, i) => rooms.push({
      id: a.area_id, name: a.name, area: a.area_id, rect: [i * 5, below, 5, 4], outdoor: true, floor: 'grass',
    }));
    return { id: lv.id, name: lv.name, floor: lv.floor, rooms, openings: [], furniture: [], lights: [], acs: [] };
  });
  return { name: 'Casa', revision: 0, levels };
}
