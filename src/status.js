// What the house view says at a glance: per-room status (lights on, AC running, doors and
// windows open) and the dock (weather, who's home, energy). Pure functions over hass.
import { isOn, entityArea } from './hass-map.js';
import { roomGroup } from './plan.js';

const OPENINGS = ['door', 'window', 'opening', 'garage_door'];
const num = (st) => { const n = parseFloat(st?.state); return Number.isFinite(n) ? n : null; };

// Contact sensors by area, rebuilt only when HA's entity registry object changes.
let openingIndex = { entities: null, byArea: new Map() };
function openingsByArea(hass) {
  if (openingIndex.entities === hass.entities) return openingIndex.byArea;
  const byArea = new Map();
  for (const [id, e] of Object.entries(hass.entities || {})) {
    if (!id.startsWith('binary_sensor.') || e.hidden || e.entity_category) continue;
    if (!OPENINGS.includes(hass.states[id]?.attributes?.device_class)) continue;
    const area = entityArea(hass, id);
    if (!area) continue;
    if (!byArea.has(area)) byArea.set(area, []);
    byArea.get(area).push(id);
  }
  openingIndex = { entities: hass.entities, byArea };
  return byArea;
}

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
  const open = area ? (openingsByArea(hass).get(area) || []).filter((id) => hass.states[id]?.state === 'on')
    .map((id) => ({ id, kind: hass.states[id].attributes.device_class === 'window' ? 'window' : 'door' })) : [];
  const t = area && num(hass.states[hass.areas?.[area]?.temperature_entity_id]);
  return { lightsOn, acs, open, temp: t, busy: lightsOn > 0 || acs.length > 0 || open.length > 0 };
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
