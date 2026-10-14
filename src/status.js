// What the house view says at a glance: per-room status (lights on, AC running, doors and
// windows open) and the dock (weather, who's home, energy). Pure functions over hass.
import { isOn, entityArea } from './hass-map.js';
import { roomGroup } from './plan.js';

const OPENINGS = ['door', 'window', 'opening', 'garage_door'];
const num = (st) => { const n = parseFloat(st?.state); return Number.isFinite(n) ? n : null; };

// Sensors by area from the registries alone (an entity's own area, else its device's), rebuilt
// whenever HA replaces the entity or device registry objects. Which ones are doors/windows or
// thermometers is decided on read: states and device classes change; the registry index doesn't.
let sensorIndex = { entities: null, devices: null, binary: new Map(), sensor: new Map() };
function sensorsByArea(hass) {
  if (sensorIndex.entities === hass.entities && sensorIndex.devices === hass.devices) return sensorIndex;
  const binary = new Map();
  const sensor = new Map();
  for (const [id, e] of Object.entries(hass.entities || {})) {
    const into = id.startsWith('binary_sensor.') ? binary : id.startsWith('sensor.') ? sensor : null;
    if (!into || e.hidden || e.entity_category) continue;
    const area = entityArea(hass, id);
    if (!area) continue;
    if (!into.has(area)) into.set(area, []);
    into.get(area).push(id);
  }
  sensorIndex = { entities: hass.entities, devices: hass.devices, binary, sensor };
  return sensorIndex;
}
const openingsIn = (hass, area) => (sensorsByArea(hass).binary.get(area) || [])
  .filter((id) => OPENINGS.includes(hass.states[id]?.attributes?.device_class));
const thermometersIn = (hass, area) => (sensorsByArea(hass).sensor.get(area) || [])
  .filter((id) => hass.states[id]?.attributes?.device_class === 'temperature');

/** Status of the room `roomId` on `level`: lights on, running ACs, open doors/windows, temperature. */
export function roomStatus(hass, level, roomId) {
  const group = roomGroup(level, roomId);
  const ids = new Set(group.map((r) => r.id));
  const area = group[0]?.area;
  const lamps = level.lights.filter((l) => ids.has(l.room) && l.entity);
  const lightsOn = lamps.filter((l) => isOn(hass.states[l.entity])).length;
  const acs = level.acs.filter((a) => ids.has(a.room) && a.entity).map((a) => hass.states[a.entity])
    .filter((st) => st && isOn(st))
    .map((st) => ({ mode: st.state, target: st.attributes.temperature, current: st.attributes.current_temperature }));
  const open = area ? openingsIn(hass, area).filter((id) => hass.states[id]?.state === 'on')
    .map((id) => ({ id, kind: hass.states[id].attributes.device_class === 'window' ? 'window' : 'door' })) : [];
  return { lightsOn, acs, open, temp: roomTemp(hass, level, ids, area), busy: lightsOn > 0 || acs.length > 0 || open.length > 0 };
}

/** The room's temperature: the area's chosen sensor, else any working temperature sensor in
 *  the area, else the room's AC's own reading. */
export function roomTemp(hass, level, ids, area) {
  const chosen = area && num(hass.states[hass.areas?.[area]?.temperature_entity_id]);
  if (chosen != null) return chosen;
  // Outdoors, "any sensor in the area" picks up things like a car's cabin; only an explicit choice counts.
  if (level.rooms.some((r) => ids.has(r.id) && r.outdoor)) return null;
  for (const id of area ? thermometersIn(hass, area) : []) {
    const v = num(hass.states[id]);
    if (v != null) return v;
  }
  for (const a of level.acs.filter((x) => ids.has(x.room) && x.entity)) {
    const v = hass.states[a.entity]?.attributes?.current_temperature;
    if (Number.isFinite(v)) return v;
  }
  return null;
}

// Heat-map colour for a temperature: blue (cold) → green (comfortable) → amber → red (hot).
const STOPS = [[17, [79, 140, 255]], [20.5, [70, 195, 154]], [23.5, [242, 193, 78]], [27, [255, 92, 61]]];
export function heatColor(t) {
  if (t == null) return null;
  if (t <= STOPS[0][0]) return STOPS[0][1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    const [t0, c0] = STOPS[i];
    const [t1, c1] = STOPS[i + 1];
    if (t <= t1) { const k = (t - t0) / (t1 - t0); return c0.map((v, j) => Math.round(v + (c1[j] - v) * k)); }
  }
  return STOPS[STOPS.length - 1][1];
}

/** Cloud cover 0..1 from a weather state, for the sky. */
export function cloudOf(state) {
  return { sunny: 0, 'clear-night': 0, partlycloudy: 0.35, windy: 0.2, 'windy-variant': 0.45, cloudy: 0.7, fog: 0.8,
    rainy: 0.85, pouring: 0.95, 'lightning-rainy': 0.95, lightning: 0.85, hail: 0.9, snowy: 0.85, 'snowy-rainy': 0.9 }[state] ?? 0.3;
}

/** Rain from a weather state: 0 none, 1 rain, 2 pouring. */
export const rainOf = (state) => ({ rainy: 1, 'snowy-rainy': 1, pouring: 2, 'lightning-rainy': 2 }[state] || 0);

const KMH = { 'km/h': 1, 'm/s': 3.6, mph: 1.609, kn: 1.852 };
/** Wind 0..1 (calm → gale) from a weather entity's wind_speed. */
export function windOf(st) {
  const v = parseFloat(st?.attributes?.wind_speed);
  if (!Number.isFinite(v)) return 0.2;
  return Math.min(1, (v * (KMH[st.attributes.wind_speed_unit] ?? 1)) / 45);
}

const WEATHER = {
  'clear-night': 'mdi:weather-night', cloudy: 'mdi:weather-cloudy', exceptional: 'mdi:alert-circle-outline',
  fog: 'mdi:weather-fog', hail: 'mdi:weather-hail', lightning: 'mdi:weather-lightning',
  'lightning-rainy': 'mdi:weather-lightning-rainy', partlycloudy: 'mdi:weather-partly-cloudy',
  pouring: 'mdi:weather-pouring', rainy: 'mdi:weather-rainy', snowy: 'mdi:weather-snowy',
  'snowy-rainy': 'mdi:weather-snowy-rainy', sunny: 'mdi:weather-sunny', windy: 'mdi:weather-windy',
  'windy-variant': 'mdi:weather-windy-variant',
};

/** The dock's contents; `cfg` is the card's `status:` option (every key optional). */
export function dockStatus(hass, cfg = {}) {
  const out = {};
  const w = hass.states[cfg.weather ?? Object.keys(hass.states).find((e) => e.startsWith('weather.'))];
  if (w) out.weather = { entity: w.entity_id, icon: WEATHER[w.state] || 'mdi:weather-partly-cloudy', temp: w.attributes.temperature };
  const people = cfg.people ?? Object.keys(hass.states).filter((e) => e.startsWith('person.'));
  out.people = people.map((id) => hass.states[id]).filter(Boolean).map((p) => ({
    entity: p.entity_id, name: p.attributes.friendly_name || p.entity_id, home: p.state === 'home',
    picture: p.attributes.entity_picture,
  }));
  for (const key of ['solar', 'battery', 'load']) {
    const st = cfg[key] && hass.states[cfg[key]];
    const v = num(st);
    if (v != null) out[key] = { entity: st.entity_id, value: v, unit: st.attributes.unit_of_measurement || '' };
  }
  return out;
}

/** The car chip: battery % and whether it is charging; `cfg` is the card's `car:` option. */
export function carStatus(hass, cfg) {
  if (!cfg) return null;
  const battery = num(hass.states[cfg.battery]);
  const ch = hass.states[cfg.charging];
  const charging = ch ? ['charging', 'on', 'true'].includes(String(ch.state).toLowerCase()) : false;
  if (battery == null && !ch) return null;
  return { battery, charging, entity: cfg.battery || cfg.charging };
}

export const fmt = (v, unit) => {
  if (v == null) return '';
  const n = Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${n}${unit}`;
};

const IDLE = ['power_off', 'off', 'initial', 'sleep', 'standby', 'unavailable', 'unknown', 'cancel', 'idle'];
const DONE = ['end', 'finished', 'complete', 'completed', 'done'];

/** Washing machine, dishwasher…: `list` is the card's `status.appliances` ([{ name, icon,
 *  status: enum sensor, ends: timestamp sensor }]). Idle ones are left out. */
export function appliancesStatus(hass, list = []) {
  return (list || []).map((a) => {
    const st = hass.states[a.status];
    if (!st) return null;
    const s = String(st.state).toLowerCase();
    if (IDLE.includes(s)) return null;
    const phase = DONE.includes(s) ? 'done' : s.includes('error') || s === 'power_fail' ? 'error' : 'running';
    const end = Date.parse(hass.states[a.ends]?.state);
    const minutes = Number.isFinite(end) ? Math.max(0, Math.round((end - Date.now()) / 60000)) : null;
    return { name: a.name || st.attributes.friendly_name, icon: a.icon || 'mdi:washing-machine', phase, minutes, entity: a.status };
  }).filter(Boolean);
}
