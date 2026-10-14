import { LitElement, html, css, nothing } from 'lit';
import { normalizePlan, planFromAreas, roomGroup } from './plan.js';
import { createStage } from './stage.js';
import { lampState, lampCaps, acState, areaGroups } from './hass-map.js';
import './editor.js';

const VERSION = '0.3.0';
const TYPE = 'custom:house-3d-card';

class House3DCard extends LitElement {
  static properties = {
    hass: { attribute: false },
    _config: { state: true },
    _error: { state: true },
    _room: { state: true },
    _peel: { state: true },
    _labels: { state: true },
    _editing: { state: true },
    _sheet: { state: true },
    _toast: { state: true },
    _showLabels: { state: true },
  };

  constructor() {
    super();
    this._labels = [];
    this._showLabels = readPref('labels') === '1';
    this._tiles = new Map();
    this._watched = new Map();
    this._onHash = () => this._fromHash();
    this._onVisibility = () => this._stage?.setRunning(this.isConnected && !document.hidden);
  }

  setConfig(config) {
    const plan = config.plan ? JSON.stringify(config.plan) : null;
    if (this._config && plan === this._planKey) { this._config = config; return; }
    this._config = config;
    this._planKey = plan;
    this._dirty = true; // rebuild the stage on the next update
  }

  getCardSize() { return 12; }
  static getStubConfig() { return {}; }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener('popstate', this._onHash);
    document.addEventListener('visibilitychange', this._onVisibility);
    this._resizeObs ??= new ResizeObserver(() => { this._stage?.resize(); this._updateLabels(); });
    this._stage?.setRunning(!document.hidden);
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener('popstate', this._onHash);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._stage?.setRunning(false);
  }

  /* ---------- plan + stage ---------- */

  get _rawPlan() {
    return this._config?.plan || (this.hass ? planFromAreas(this.hass) : null);
  }

  _build() {
    this._dirty = false;
    this._stage?.dispose();
    this._stage = null;
    this._error = null;
    const host = this.renderRoot.querySelector('.canvas');
    const raw = this._rawPlan;
    if (!host || !raw) return;
    try {
      this._plan = normalizePlan(raw);
    } catch (e) {
      this._error = e.message;
      return;
    }
    const canvas = document.createElement('canvas');
    host.replaceChildren(canvas);
    try {
      this._stage = createStage(canvas, this._plan, {
        onPick: (t) => this._pick(t),
        onLongPress: (t) => this._moreInfo(t.cfg?.entity),
        onMove: () => this._updateLabels(),
        capsOf: (cfg) => lampCaps(this.hass?.states[cfg.entity]),
      });
    } catch (e) {
      this._error = `3D is not available on this device (${e.message}).`;
      return;
    }
    this._resizeObs.observe(host);
    // Start on the ground storey; the chips peel up to the others.
    const levels = [...this._plan.levels].sort((a, b) => a.elevation - b.elevation);
    if (!levels.some((l) => l.id === this._peel)) this._peel = levels[0].id;
    this._stage.setPeel(levels.length > 1 ? this._peel : null);
    this._stage.setRunning(this.isConnected && !document.hidden);
    this._fromHash(true);
    this._updateLabels();
  }

  _roomCfg(id) {
    for (const l of this._plan?.levels || []) {
      const r = l.rooms.find((x) => x.id === id);
      if (r) return { level: l, room: r };
    }
    return null;
  }

  _fromHash(initial = false) {
    const id = new URLSearchParams(location.hash.slice(1)).get('room');
    if (!this._stage || (id || null) === (this._room?.id || null)) return;
    this._focus(id && this._roomCfg(id) ? id : null, { push: false, initial });
  }

  _focus(id, { push = true } = {}) {
    const found = id ? this._roomCfg(id) : null;
    this._room = found ? { id, level: found.level.id, name: found.room.name, area: found.room.area } : null;
    this._stage.focusRoom(this._room);
    this._watched = new Map();
    this._syncStates();
    this._loadSheet();
    if (push) {
      const url = new URL(location.href);
      url.hash = this._room ? `room=${encodeURIComponent(id)}` : '';
      history.pushState(history.state, '', url);
    }
    this._updateLabels();
  }

  _back() {
    if (new URLSearchParams(location.hash.slice(1)).get('room')) history.back();
    else this._focus(null, { push: false });
  }

  _updateLabels() {
    if (this._stage) this._labels = this._stage.labels();
  }

  // Push live state into the focused room's lamps/ACs, only when one of them changed.
  _syncStates() {
    if (!this._stage || !this._room || !this.hass) return;
    const lv = this._plan.levels.find((l) => l.id === this._room.level);
    const rooms = roomGroup(lv, this._room.id).map((r) => r.id);
    const ids = [...lv.lights, ...lv.acs].filter((d) => rooms.includes(d.room)).map((d) => d.entity).filter(Boolean);
    if (ids.length && ids.every((e) => this._watched.get(e) === this.hass.states[e])) return;
    this._watched = new Map(ids.map((e) => [e, this.hass.states[e]]));
    this._stage.applyStates((kind, cfg) => (kind === 'light'
      ? lampState(this.hass.states[cfg.entity]) : acState(this.hass.states[cfg.entity])));
  }

  _pick(t) {
    if (!t) return;
    if (t.kind === 'room') {
      const lv = this._room && this._plan.levels.find((l) => l.id === this._room.level);
      if (!lv || !roomGroup(lv, this._room.id).some((r) => r.id === t.id)) this._focus(t.id);
      return;
    }
    const entity = t.cfg?.entity;
    if (!entity) return;
    if (t.kind === 'light') this.hass.callService('homeassistant', 'toggle', { entity_id: entity }).catch((e) => this._say(e.message));
    else this._moreInfo(entity);
  }

  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }

  _say(text) {
    this._toast = text;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = null; }, 4000);
  }

  /* ---------- room sheet: HA's own tile cards ---------- */

  async _curation() {
    if (this._curationPromise) return this._curationPromise;
    const path = this._config.areas_dashboard ?? 'dashboard-areas';
    this._curationPromise = this.hass.callWS({ type: 'lovelace/config', url_path: path })
      .then((c) => c?.strategy?.areas_options || {}).catch(() => ({}));
    return this._curationPromise;
  }

  async _loadSheet() {
    const room = this._room;
    if (!room) { this._sheet = null; return; }
    if (!room.area) { this._sheet = { room, groups: [], note: 'This room is not linked to an HA area.' }; return; }
    if (!this.hass.areas?.[room.area]) { this._sheet = { room, groups: [], note: 'Area not found.' }; return; }
    const [helpers, curation] = await Promise.all([window.loadCardHelpers?.(), this._curation()]);
    if (this._room !== room) return;
    const groups = areaGroups(this.hass, room.area, curation).map((g) => ({
      ...g, cards: g.entities.map((e) => this._tile(helpers, e)).filter(Boolean),
    }));
    this._sheet = { room, groups };
  }

  _tile(helpers, entity) {
    if (this._tiles.has(entity)) return this._tiles.get(entity);
    if (!helpers) return null;
    const domain = entity.split('.')[0];
    const cfg = { type: 'tile', entity, features_position: 'bottom' };
    if (domain === 'light' && lampCaps(this.hass.states[entity]).includes('brightness')) cfg.features = [{ type: 'light-brightness' }];
    if (domain === 'climate') cfg.features = [{ type: 'target-temperature' }];
    const el = helpers.createCardElement(cfg);
    el.hass = this.hass;
    this._tiles.set(entity, el);
    return el;
  }

  _reading(entityId, unit) {
    const st = entityId && this.hass.states[entityId];
    if (!st || isNaN(parseFloat(st.state))) return null;
    return `${Math.round(parseFloat(st.state) * 10) / 10}${unit ?? st.attributes.unit_of_measurement ?? ''}`;
  }

  /* ---------- editor ---------- */

  async _save(plan) {
    const urlPath = this._config.dashboard ?? location.pathname.split('/')[1];
    const lovelace = await this.hass.callWS({ type: 'lovelace/config', url_path: urlPath === 'lovelace' ? null : urlPath });
    const card = findCard(lovelace);
    if (!card) throw new Error(`No ${TYPE} found in dashboard "${urlPath}"`);
    const was = this._config.plan?.revision || 0;
    if ((card.plan?.revision || 0) !== was) {
      throw new Error('The plan was changed elsewhere since you opened the editor. Close the editor to load it, then redo your change.');
    }
    card.plan = { ...plan, revision: was + 1 };
    await this.hass.callWS({ type: 'lovelace/config/save', url_path: urlPath === 'lovelace' ? null : urlPath, config: lovelace });
    this.setConfig({ ...this._config, plan: card.plan }); // HA reloads too; don't wait for it
    this._editing = false;
    this._say('Plan saved');
  }

  /* ---------- lifecycle ---------- */

  updated(changed) {
    if (this._dirty && this.hass) this._build();
    if (changed.has('hass') && this.hass) {
      this._syncStates();
      for (const el of this._tiles.values()) el.hass = this.hass;
    }
  }

  render() {
    if (!this._config) return nothing;
    const plan = this._plan;
    const admin = this.hass?.user?.is_admin;
    const levels = plan ? [...plan.levels].sort((a, b) => a.elevation - b.elevation) : [];
    const sheet = this._room && this._sheet?.room === this._room ? this._sheet : null;
    const area = this._room?.area && this.hass?.areas?.[this._room.area];
    const temp = area && this._reading(area.temperature_entity_id);
    const hum = area && this._reading(area.humidity_entity_id, '%');

    return html`
      <div class="wrap ${this._room ? 'has-sheet' : ''}" style="height:${this._config.height || 'calc(100vh - var(--header-height, 56px) - 16px)'}">
        <div class="stage">
          <div class="canvas"></div>
          ${this._room || !this._showLabels ? nothing : this._labels.map((l) => html`
            <button class="label" style="left:${l.x}px;top:${l.y}px" @click=${() => this._focus(l.id)}>${l.name}</button>`)}
          <div class="bar">
            ${this._room ? html`
              <button class="chip back" @click=${() => this._back()}>← ${plan?.name || 'Casa'}</button>
              <span class="title">${this._room.name}</span>` : html`
              <span class="title">${plan?.name || 'Casa'}</span>
              ${levels.length > 1 ? levels.map((l) => html`
                <button class="chip ${this._peel === l.id ? 'on' : ''}" @click=${() => this._setPeel(l.id)}>${l.name}</button>`) : nothing}`}
            <span class="grow"></span>
            ${this._room ? nothing : html`<button class="chip icon ${this._showLabels ? 'on' : ''}" title="Room names"
              @click=${() => this._toggleLabels()}>Aa</button>`}
            ${admin ? html`<button class="chip icon" title="Edit house" @click=${() => { this._editing = true; }}>✎</button>` : nothing}
          </div>
          ${this._error ? html`<div class="error"><b>Can't show the house</b><p>${this._error}</p></div>` : nothing}
          ${!this._config.plan && plan && !this._room ? html`<div class="hint">Starter layout from your HA areas — tap ✎ to arrange the rooms.</div>` : nothing}
          ${this._toast ? html`<div class="toast">${this._toast}</div>` : nothing}
        </div>
        ${this._room ? html`
          <aside class="sheet">
            <header>
              <h2>${this._room.name}</h2>
              ${temp || hum ? html`<span class="climate">${[temp, hum].filter(Boolean).join(' · ')}</span>` : nothing}
            </header>
            ${sheet?.note ? html`<p class="note">${sheet.note}</p>` : nothing}
            ${!sheet ? html`<p class="note">Loading…</p>` : nothing}
            ${sheet?.groups.map((g) => html`<h3>${g.title}</h3><div class="tiles">${g.cards}</div>`)}
          </aside>` : nothing}
      </div>
      ${this._editing ? html`
        <house-3d-editor .hass=${this.hass} .plan=${structuredClone(this._rawPlan)}
          .save=${(p) => this._save(p)} @close=${() => { this._editing = false; }}></house-3d-editor>` : nothing}
    `;
  }

  _toggleLabels() {
    this._showLabels = !this._showLabels;
    writePref('labels', this._showLabels ? '1' : '0');
  }

  _setPeel(id) {
    this._peel = id;
    this._stage?.setPeel(id);
    this._updateLabels();
  }

  static styles = css`
    :host { display: block; }
    .wrap { display: flex; position: relative; border-radius: var(--ha-card-border-radius, 12px); overflow: hidden; background: #0a0e1a; min-height: 360px; }
    .stage { position: relative; flex: 1; min-width: 0; }
    .canvas, .canvas canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; touch-action: none; }
    .bar { position: absolute; top: 0; left: 0; right: 0; display: flex; gap: 6px; align-items: center; padding: 10px 12px; flex-wrap: wrap; pointer-events: none; }
    .bar > * { pointer-events: auto; }
    .title { color: #eef1f8; font-weight: 600; font-size: 17px; margin-right: 8px; text-shadow: 0 1px 6px #000; }
    .grow { flex: 1; }
    .chip { font: inherit; font-size: 13px; color: #cfd6e6; background: rgba(20, 26, 42, 0.75); border: 1px solid rgba(255,255,255,0.12);
      border-radius: 999px; padding: 5px 12px; cursor: pointer; backdrop-filter: blur(6px); }
    .chip.on { background: #e9eefb; color: #0a0e1a; }
    .chip.icon { font-size: 15px; padding: 4px 10px; }
    .label { position: absolute; transform: translate(-50%, -50%); font: inherit; font-size: 12px; color: #fff; background: rgba(10, 14, 26, 0.55);
      border: 0; border-radius: 6px; padding: 2px 7px; cursor: pointer; white-space: nowrap; text-shadow: 0 1px 3px #000; }
    .label:hover { background: rgba(80, 110, 200, 0.7); }
    .error, .hint, .toast { position: absolute; left: 50%; transform: translateX(-50%); background: rgba(20, 26, 42, 0.92); color: #eef1f8;
      border-radius: 10px; padding: 10px 14px; font-size: 13px; max-width: 80%; }
    .error { top: 30%; border: 1px solid #e05252; }
    .error p { margin: 6px 0 0; white-space: pre-wrap; }
    .hint { bottom: 14px; }
    .toast { bottom: 54px; }
    .sheet { width: 380px; flex: none; overflow-y: auto; background: var(--card-background-color, #1c1f26); padding: 12px 12px 24px; box-sizing: border-box; }
    .sheet header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .sheet h2 { margin: 4px 0 8px; font-size: 20px; font-weight: 600; color: var(--primary-text-color); }
    .sheet h3 { margin: 14px 2px 6px; font-size: 13px; font-weight: 500; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.04em; }
    .climate { color: var(--secondary-text-color); font-size: 14px; }
    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .note { color: var(--secondary-text-color); }
    @media (max-width: 800px), (orientation: portrait) and (max-width: 1100px) {
      .wrap.has-sheet { flex-direction: column; }
      .wrap.has-sheet .stage { flex: 0 0 52%; }
      .sheet { width: auto; flex: 1; }
    }
  `;
}

// Per-viewer UI preferences; storage can be unavailable (private mode, previews).
function readPref(key) {
  try { return localStorage.getItem(`house-3d-card.${key}`); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(`house-3d-card.${key}`, value); } catch { /* not persisted */ }
}

function findCard(node) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === TYPE) return node;
  for (const v of Object.values(node)) {
    const hit = Array.isArray(v) ? v.map(findCard).find(Boolean) : typeof v === 'object' ? findCard(v) : null;
    if (hit) return hit;
  }
  return null;
}

customElements.define('house-3d-card', House3DCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'house-3d-card', name: 'House 3D', description: 'A live 3D model of your home' });
console.info(`%c HOUSE-3D-CARD %c ${VERSION} `, 'background:#3b5bdb;color:#fff', 'background:#e9eefb;color:#0a0e1a');
