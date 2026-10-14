// Home Assistant state ⇄ the 3D units' vocabulary, and which entities belong to an area.

const hex = ([r, g, b]) => `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
const COLOR_MODES = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];

export const isOn = (st) => Boolean(st) && !['off', 'unavailable', 'unknown'].includes(st.state);

// What a LightUnit shows: on, brightness 0..1, temp in kelvin, color "#rrggbb".
export function lampState(st) {
  if (!st || !isOn(st)) return { on: false, brightness: 1, temp: 3000 };
  const a = st.attributes || {};
  const out = { on: true, brightness: a.brightness != null ? a.brightness / 255 : 1, temp: a.color_temp_kelvin || 3000 };
  if (COLOR_MODES.includes(a.color_mode) && Array.isArray(a.rgb_color)) out.color = hex(a.rgb_color);
  return out;
}

export function lampCaps(st) {
  const modes = st?.attributes?.supported_color_modes || [];
  const caps = [];
  if (modes.some((m) => m !== 'onoff')) caps.push('brightness');
  if (modes.includes('color_temp')) caps.push('temp');
  if (modes.some((m) => COLOR_MODES.includes(m))) caps.push('color');
  return caps;
}

const HVAC = { cool: 'cool', heat: 'heat', dry: 'dry', fan_only: 'fan', heat_cool: 'auto', auto: 'auto' };

function fanName(name = '') {
  const n = String(name).toLowerCase();
  if (['turbo', 'max', 'strong', 'highest', 'powerful', 'boost'].some((w) => n.includes(w))) return 'turbo';
  if (n.includes('high')) return 'high';
  if (n.includes('med') || n.includes('mid')) return 'medium';
  if (n.includes('low') || n.includes('quiet') || n.includes('silent')) return 'low';
  return 'auto';
}

// What an ACUnit shows: on, mode, fan, swing.
export function acState(st) {
  if (!st || !isOn(st)) return { on: false, mode: 'cool', fan: 'auto', swing: 'off' };
  const a = st.attributes || {};
  return {
    on: true,
    mode: HVAC[st.state] || 'auto',
    fan: fanName(a.fan_mode),
    swing: a.swing_mode && a.swing_mode !== 'off' ? 'swing' : 'off',
  };
}

/* ---------- areas ---------- */

const DOORISH = ['door', 'window', 'garage_door', 'opening'];
const SECURITY = ['lock', 'alarm_control_panel', 'camera', 'siren'];

// Mirrors the Areas dashboard's groups, so its hidden/order curation applies as-is.
export const GROUPS = [
  { key: 'lights', title: 'Lights' },
  { key: 'climate', title: 'Climate' },
  { key: 'covers', title: 'Doors & windows' },
  { key: 'media_players', title: 'Media' },
  { key: 'security', title: 'Security' },
  { key: 'others', title: 'Other' },
];

function groupOf(hass, id) {
  const domain = id.split('.')[0];
  const dc = hass.states[id]?.attributes?.device_class;
  if (domain === 'light') return 'lights';
  if (['climate', 'fan', 'humidifier', 'water_heater'].includes(domain)) return 'climate';
  if (domain === 'cover' || (domain === 'binary_sensor' && DOORISH.includes(dc))) return 'covers';
  if (domain === 'media_player') return 'media_players';
  if (SECURITY.includes(domain)) return 'security';
  if (['switch', 'input_boolean', 'vacuum', 'valve', 'lawn_mower', 'scene', 'script', 'button', 'select'].includes(domain)) return 'others';
  return null; // sensors and the rest: not controls
}

export function entityArea(hass, id) {
  const e = hass.entities?.[id];
  if (!e) return null;
  return e.area_id || hass.devices?.[e.device_id]?.area_id || null;
}

// Every entity of the area worth a control, by group, honouring the Areas dashboard curation.
export function areaGroups(hass, areaId, curation) {
  const buckets = new Map(GROUPS.map((g) => [g.key, []]));
  for (const [id, e] of Object.entries(hass.entities || {})) {
    if (e.hidden || e.entity_category || !hass.states[id]) continue;
    if (entityArea(hass, id) !== areaId) continue;
    const g = groupOf(hass, id);
    if (g) buckets.get(g).push(id);
  }
  const opts = curation?.[areaId]?.groups_options || {};
  const name = (id) => hass.states[id]?.attributes?.friendly_name || id;
  return GROUPS.map((g) => {
    const { hidden = [], order = [] } = opts[g.key] || {};
    const rank = (id) => { const i = order.indexOf(id); return i < 0 ? order.length : i; };
    const entities = buckets.get(g.key).filter((id) => !hidden.includes(id))
      .sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
    return { ...g, entities };
  }).filter((g) => g.entities.length);
}

// Entities of a domain list in an area (editor pickers): area's own first, then the rest.
export function entitiesFor(hass, domains, areaId) {
  const all = Object.keys(hass.states).filter((id) => domains.includes(id.split('.')[0])
    && !hass.entities?.[id]?.hidden && !hass.entities?.[id]?.entity_category);
  const inArea = all.filter((id) => entityArea(hass, id) === areaId);
  const name = (id) => hass.states[id]?.attributes?.friendly_name || id;
  const rank = (id) => domains.indexOf(id.split('.')[0]);
  const sort = (xs) => xs.sort((a, b) => rank(a) - rank(b) || name(a).localeCompare(name(b)));
  return { inArea: sort(inArea), rest: sort(all.filter((id) => !inArea.includes(id))) };
}
