// A fake `hass` built from a snapshot of the real instance (dev/fixture.json, gitignored), so the
// card runs in a plain browser: `npm run dev`, then open /dev/ (?plan=saved uses the last saved plan).
import '../src/house-3d-card.js';
import fixture from './fixture.json';
import areasDashboard from './dashboard-areas.json';

const log = (t) => { document.getElementById('log').textContent = t; console.log(t); };

const states = {};
for (const e of fixture.entities) {
  states[e.entity_id] = { entity_id: e.entity_id, state: e.state, attributes: e.attributes, last_changed: '' };
}
// ?sun=elevation,azimuth (degrees) to look at any time of day; default mid-afternoon.
const [sunEl, sunAz] = (new URLSearchParams(location.search).get('sun') || '35,230').split(',').map(Number);
states['sun.sun'] = { entity_id: 'sun.sun', state: sunEl > 0 ? 'above_horizon' : 'below_horizon', attributes: { elevation: sunEl, azimuth: sunAz } };

// Synthetic status entities (weather, people, energy, car) and a busy house, so the house
// view's pills and dock have something to show.
const add = (entity_id, state, attributes = {}) => { states[entity_id] = { entity_id, state, attributes }; };
add('weather.dev', 'partlycloudy', { temperature: 21.5, friendly_name: 'Weather', wind_speed: Number(new URLSearchParams(location.search).get('wind') ?? 14), wind_speed_unit: 'km/h' });
add('person.dev_a', 'home', { friendly_name: 'Fabio' });
add('person.dev_b', 'not_home', { friendly_name: 'Sara', user_id: 'u-sara' });
add('sensor.dev_solar', '2.4', { unit_of_measurement: 'kW', device_class: 'power' });
add('sensor.dev_battery', '76', { unit_of_measurement: '%', device_class: 'battery' });
add('sensor.dev_load', '1.3', { unit_of_measurement: 'kW', device_class: 'power' });
add('sensor.dev_car_battery', '54', { unit_of_measurement: '%' });
add('sensor.dev_car_charging', 'charging');
add('sensor.dev_dish_status', 'rinsing');
add('sensor.dev_dish_ends', new Date(Date.now() + 42 * 60000).toISOString(), { device_class: 'timestamp' });
add('sensor.dev_wash_status', 'end');
const ac = Object.keys(states).find((e) => e.startsWith('climate.ac_sala'));
if (ac) states[ac] = { ...states[ac], state: 'cool', attributes: { ...states[ac].attributes, temperature: 23, current_temperature: 25.5 } };
// Open a door and a window (if they exist in the fixture) and switch a TV on.
const opened = Object.keys(states).filter((e) => e.startsWith('binary_sensor.') && ['window', 'door'].includes(states[e].attributes.device_class))
  .filter((e) => /sala_mesa|w6_cozinha/.test(e));
for (const e of opened.length ? opened : Object.keys(states).filter((x) => states[x].attributes?.device_class === 'window').slice(0, 1)) states[e] = { ...states[e], state: 'on' };
// The pool light on, blue (its colour tints the water at night).
const pool = Object.keys(states).find((e) => e.startsWith('light.') && /piscina/.test(e) && !/^light\.piscina$/.test(e));
if (pool) states[pool] = { ...states[pool], state: 'on', attributes: { ...states[pool].attributes, color_mode: 'xy', rgb_color: [30, 140, 255], brightness: 255 } };
// ?weather=cloudy etc.
const wx = new URLSearchParams(location.search).get('weather');
if (wx) setTimeout(() => setState('weather.dev', wx), 0);
const tv = Object.keys(states).find((e) => e.startsWith('media_player.') && /tv/.test(e));
if (tv) states[tv] = { ...states[tv], state: 'on' };

const scenes = {};
let hass = {
  states,
  entities: Object.fromEntries(fixture.entities.map((e) => [e.entity_id, { entity_id: e.entity_id, area_id: e.area_id }])),
  devices: {},
  areas: Object.fromEntries(fixture.areas.map((a) => [a.area_id, a])),
  floors: Object.fromEntries(fixture.floors.map((f) => [f.floor_id, f])),
  user: { is_admin: true, name: 'dev', id: 'u-dev' },
  config: { latitude: 38.95, longitude: -9.07 },
  locale: { language: new URLSearchParams(location.search).get('lang') || 'en' },
  callService: async (domain, service, data) => {
    const ids = [data.entity_id ?? []].flat();
    log(`${domain}.${service} ${ids.join(', ')}`);
    if (domain === 'scene' && service === 'create') {
      scenes[data.scene_id] = Object.fromEntries(data.snapshot_entities.map((e) => [e, hass.states[e].state]));
      return;
    }
    if (domain === 'scene' && service === 'turn_on') {
      for (const [e, st] of Object.entries(scenes[ids[0].replace('scene.', '')] || {})) setState(e, st);
      return;
    }
    for (const id of ids) {
      const st = hass.states[id];
      if (!st) continue;
      if (service === 'toggle') setState(id, st.state === 'on' ? 'off' : 'on');
      if (service === 'turn_on') setState(id, 'on');
      if (service === 'turn_off') setState(id, 'off');
    }
  },
  callWS: async (msg) => {
    if (msg.type === 'history/history_during_period') {
      // A plausible day: evening lights, a morning door, the TV after dinner.
      const t0 = Date.parse(msg.start_time) / 1000;
      const out = {};
      msg.entity_ids.forEach((id, i) => {
        const at = (h) => t0 + h * 3600;
        const rows = [{ s: 'off', lu: t0 }];
        if (id.startsWith('light.')) rows.push({ s: 'on', lu: at(17.5 + (i % 5) * 0.4) }, { s: 'off', lu: at(22 + (i % 4) * 0.5) }, { s: 'on', lu: at(31) }, { s: 'off', lu: at(32 + (i % 3) * 0.3) });
        if (id.startsWith('binary_sensor.')) rows.push({ s: 'on', lu: at(8 + i % 6) }, { s: 'off', lu: at(8.4 + i % 6) });
        if (id.startsWith('media_player.')) rows.push({ s: 'on', lu: at(21) }, { s: 'off', lu: at(23.5) });
        out[id] = rows;
      });
      return out;
    }
    if (msg.type === 'lovelace/config' && msg.url_path === 'dashboard-areas') return areasDashboard;
    if (msg.type === 'lovelace/config') return structuredClone(dashboard);
    if (msg.type === 'lovelace/config/save') {
      dashboard = msg.config;
      localStorage.setItem('house3d-dashboard', JSON.stringify(dashboard));
      log('saved dashboard');
      return null;
    }
    throw new Error(`unknown ws ${msg.type}`);
  },
};

function setState(id, state, userId = 'u-dev') {
  const st = hass.states[id];
  hass = { ...hass, states: { ...hass.states, [id]: { ...st, state, context: { user_id: userId } } } };
  card.hass = hass;
}

// Stand-in for HA's tile card.
class FakeTile extends HTMLElement {
  setConfig(c) { this.c = c; }
  set hass(h) {
    const st = h.states[this.c.entity];
    this.innerHTML = `<div style="background:#2a2e38;border-radius:10px;padding:8px 10px;font-size:13px;cursor:pointer">
      <div style="color:#fff">${st?.attributes.friendly_name || this.c.entity}</div>
      <div style="color:#9b9ea5">${st?.state ?? '?'}</div></div>`;
    this.onclick = () => hass.callService('homeassistant', 'toggle', { entity_id: this.c.entity });
  }
}
customElements.define('fake-tile', FakeTile);

// Stand-in for HA's ha-icon: a glyph per icon family.
const GLYPH = { history: '⏱', play: '▶', pause: '⏸', heart: '♥', crosshairs: '⌖', dishwasher: '🍽', 'washing-machine': '🧺', check: '✅', thermometer: '🌡', lightbulb: '💡', snowflake: '❄', fire: '🔥', door: '🚪', window: '🪟', weather: '⛅', solar: '☀', battery: '🔋',
  lightning: '⚡', car: '🚗', fan: '🌀', water: '💧' };
customElements.define('ha-icon', class extends HTMLElement {
  static get observedAttributes() { return ['icon']; }
  attributeChangedCallback() { const k = Object.keys(GLYPH).find((g) => (this.getAttribute('icon') || '').includes(g)); this.textContent = GLYPH[k] || '•'; }
});
window.loadCardHelpers = async () => ({
  createCardElement: (c) => {
    const el = c.type === 'tile' ? document.createElement('fake-tile') : document.createElement('div');
    el.setConfig?.(c);
    return el;
  },
});
window.addEventListener('hass-more-info', (e) => log(`more-info ${e.detail.entityId}`));

const saved = new URLSearchParams(location.search).get('plan') === 'saved' && localStorage.getItem('house3d-dashboard');
// dev/plan.json (gitignored), when present, is the starting plan.
const devPlan = Object.values(import.meta.glob('./plan.json', { eager: true, import: 'default' }))[0];
let dashboard = saved ? JSON.parse(saved)
  : { views: [{ type: 'panel', cards: [{ type: 'custom:house-3d-card', dashboard: 'house-3d', ...(devPlan ? { plan: devPlan } : {}),
    status: { weather: 'weather.dev', people: ['person.dev_a', 'person.dev_b'], solar: 'sensor.dev_solar', battery: 'sensor.dev_battery', load: 'sensor.dev_load',
      appliances: [{ name: 'Loiça', icon: 'mdi:dishwasher', status: 'sensor.dev_dish_status', ends: 'sensor.dev_dish_ends' },
        { name: 'Roupa', icon: 'mdi:washing-machine', status: 'sensor.dev_wash_status' }] },
    car: { battery: 'sensor.dev_car_battery', charging: 'sensor.dev_car_charging' } }] }] };

const card = document.createElement('house-3d-card');
card.setConfig(dashboard.views[0].cards[0]);
card.hass = hass;
document.getElementById('root').append(card);
window.card = card;
window.setState = setState; // tests: setState(id, state, userId)

// A real HA pushes a new hass object every few seconds (sensors tick); do the same so bugs that
// only show under live updates (e.g. the editor losing edits) reproduce here.
setInterval(() => {
  const id = Object.keys(hass.states).find((e) => e.startsWith('sensor.'));
  if (id) setState(id, String((Math.random() * 30).toFixed(1)));
}, 1500);
window.setState = setState;
