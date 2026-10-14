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

let hass = {
  states,
  entities: Object.fromEntries(fixture.entities.map((e) => [e.entity_id, { entity_id: e.entity_id, area_id: e.area_id }])),
  devices: {},
  areas: Object.fromEntries(fixture.areas.map((a) => [a.area_id, a])),
  floors: Object.fromEntries(fixture.floors.map((f) => [f.floor_id, f])),
  user: { is_admin: true, name: 'dev' },
  callService: async (domain, service, data) => {
    const id = data.entity_id;
    const st = hass.states[id];
    log(`${domain}.${service} ${id}`);
    if (service === 'toggle' && st) setState(id, st.state === 'on' ? 'off' : 'on');
  },
  callWS: async (msg) => {
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

function setState(id, state) {
  const st = hass.states[id];
  hass = { ...hass, states: { ...hass.states, [id]: { ...st, state } } };
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
  : { views: [{ type: 'panel', cards: [{ type: 'custom:house-3d-card', dashboard: 'house-3d', ...(devPlan ? { plan: devPlan } : {}) }] }] };

const card = document.createElement('house-3d-card');
card.setConfig(dashboard.views[0].cards[0]);
card.hass = hass;
document.getElementById('root').append(card);
window.card = card;
window.setState = setState;
