import { LitElement, html, css, nothing } from 'lit';
import { normalizePlan, planFromAreas, roomGroup } from './plan.js';
import { createStage } from './stage.js';
import { lampState, lampCaps, acState, areaGroups, isOn } from './hass-map.js';
import { roomStatus, dockStatus, carStatus, fmt, heatColor, cloudOf, roomTemp, appliancesStatus } from './status.js';
import { strings } from './i18n.js';
import { loadHistory, stateAt, sunPosition, skyGradient } from './replay.js';
import './editor.js';

const VERSION = '0.15.0';
let introPlayed = false; // once per page load, not per element (HA recreates cards on reloads)
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
    _carAt: { state: true },
    _sheetBig: { state: true },
    _heat: { state: true },
    _away: { state: true },
    _ambient: { state: true },
    _replay: { state: true },
  };

  constructor() {
    super();
    this._labels = [];
    this._showLabels = readPref('labels') === '1';
    this._heat = readPref('heat') === '1';
    this._tiles = new Map();
    this._watched = new Map();
    this._onHash = () => this._fromHash();
    this._onVisibility = () => {
      this._stage?.setRunning(this.isConnected && !document.hidden);
      if (!document.hidden) this._poke(); // re-arm the idle orbit after the screen wakes
    };
  }

  setConfig(config) {
    const plan = config.plan ? JSON.stringify(config.plan) : null;
    if (this._config && plan === this._planKey) { this._config = config; return; }
    this._config = config;
    this._planKey = plan;
    this._dirty = true; // rebuild the stage on the next update
  }

  getCardSize() { return 12; }

  get _t() { return strings(this.hass, this._config?.language); }
  static getStubConfig() { return {}; }

  // Idle showcase: after `idle_orbit` seconds without a touch (default 180, false = off) the
  // house view slowly orbits — meant for the always-on kitchen tablet.
  _poke() {
    this._stage?.setIdleOrbit(false);
    if (this._ambient) this._ambient = false;
    clearTimeout(this._idleTimer);
    const secs = this._config?.idle_orbit ?? 180;
    if (!secs) return;
    this._idleTimer = setTimeout(() => {
      if (this._room || this._editing || document.hidden) return;
      this._stage?.setIdleOrbit(true);
      // Ambient mode (wall tablets): the controls fade away and a big clock takes the sky.
      if (this._config?.ambient !== false) this._ambient = true;
    }, secs * 1000);
  }

  connectedCallback() {
    super.connectedCallback();
    this._onPoke ??= () => this._poke();
    for (const ev of ['pointerdown', 'wheel', 'keydown']) this.addEventListener(ev, this._onPoke, { passive: true });
    window.addEventListener('popstate', this._onHash);
    document.addEventListener('visibilitychange', this._onVisibility);
    this._resizeObs ??= new ResizeObserver(() => { this._stage?.resize(); this._updateLabels(); });
    clearTimeout(this._disposeT);
    if (this._dirty) this.requestUpdate(); // stage was released while detached: rebuild it
    this._stage?.setRunning(!document.hidden);
    if (this._stage) this._poke();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    clearTimeout(this._idleTimer);
    for (const ev of ['pointerdown', 'wheel', 'keydown']) this.removeEventListener(ev, this._onPoke);
    window.removeEventListener('popstate', this._onHash);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this._stage?.setRunning(false);
    clearInterval(this._tick);
    this._tick = null;
    // HA rebuilds card elements on every dashboard reload (reconnects, app resume, saves): a
    // detached card must give its WebGL context back, or contexts pile up until the GPU evicts
    // them. Short detaches (moving the card around) keep it.
    clearTimeout(this._disposeT);
    this._disposeT = setTimeout(() => {
      this._stage?.dispose();
      this._stage = null;
      this._dirty = true;
    }, 5000);
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
        intro: !introPlayed && !new URLSearchParams(location.hash.slice(1)).get('room'),
      });
      introPlayed = true;
    } catch (e) {
      this._error = `3D is not available on this device (${e.message}).`;
      return;
    }
    this._glowIds = null;
    this._liveIds = null;
    this._heatKey = undefined;
    this._syncHouse(true);
    this._syncLive(true);
    this._poke();
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
    this._poke();
    if (id && this._replay) this._stopReplay();
    const found = id ? this._roomCfg(id) : null;
    if (!found) this._sheetBig = false;
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
    if (!this._stage) return;
    const away = this._stage.isAway();
    if (away !== this._away) this._away = away;
    const labels = this._stage.labels();
    const key = labels.map((l) => `${l.id}:${Math.round(l.x)},${Math.round(l.y)}`).join('|');
    if (key !== this._labelsKey) { this._labelsKey = key; this._labels = labels; }
    // The car chip floats above the first car in the plan.
    const lv = this._plan.levels.find((l) => l.furniture.some((f) => f.type === 'car'));
    const car = lv?.furniture.find((f) => f.type === 'car');
    const at = car && !this._room ? this._stage.project([car.pos[0], lv.elevation + 1.9 * (car.scale || 1), car.pos[1]]) : null;
    if (Math.round(at?.x) !== Math.round(this._carAt?.x) || Math.round(at?.y) !== Math.round(this._carAt?.y)) this._carAt = at;
  }

  // The ambient clock: time, date in the viewer's language, the weather. Re-rendered by the
  // 30 s tick while shown.
  _clock() {
    if (!this._clockTick) this._clockTick = setInterval(() => (this._ambient ? this.requestUpdate() : (clearInterval(this._clockTick), this._clockTick = null)), 15000);
    const lang = this._config.language || this.hass.locale?.language || 'en';
    const now = new Date();
    const time = new Intl.DateTimeFormat(lang, { hour: '2-digit', minute: '2-digit' }).format(now);
    const raw = new Intl.DateTimeFormat(lang, { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
    const date = raw.charAt(0).toUpperCase() + raw.slice(1); // "Quinta-feira, 15 de outubro", not Title Case
    const d = this._dockMemo?.d || dockStatus(this.hass, this._statusCfg());
    const home = d.people?.filter((p) => p.home).map((p) => p.name.split(' ')[0]);
    return html`<div class="clock">
      <div class="time">${time}</div>
      <div class="date">${date}</div>
      <div class="sub">
        ${d.weather ? html`<span><ha-icon icon=${d.weather.icon}></ha-icon>${fmt(d.weather.temp, '°')}</span>` : nothing}
        ${home?.length ? html`<span><ha-icon icon="mdi:home-heart"></ha-icon>${home.join(' · ')}</span>` : nothing}
      </div>
    </div>`;
  }

  /* ---------- time machine ---------- */

  async _startReplay() {
    const end = Date.now();
    const start = end - 24 * 3600 * 1000;
    const entities = [...new Set([...this._stage.glowEntities(), ...this._stage.liveEntities()])];
    this._replay = { start, end, t: start, playing: false, loading: true };
    try {
      const history = await loadHistory(this.hass, entities, start, end);
      if (!this._replay) return;
      this._replay = { ...this._replay, history, loading: false };
      this._seek(start);
      this._play(true);
    } catch (e) {
      this._replay = null;
      this._say(e.message);
    }
  }

  _seek(t) {
    const r = this._replay;
    if (!r?.history) return;
    r.t = Math.min(r.end, Math.max(r.start, t));
    const { latitude = 38.7, longitude = -9.1 } = this.hass.config || {};
    const sun = sunPosition(r.t, latitude, longitude);
    this._stage.setSun(sun.elevation, sun.azimuth);
    this._stage.applyGlows((cfg) => ({ on: stateAt(r.history, cfg.entity, r.t) === 'on', brightness: 1, temp: 2900 }));
    this._stage.applyLive((e) => ({ state: stateAt(r.history, e, r.t) ?? 'off' }));
    this._replay = { ...r };
  }

  // 24 hours in ~24 seconds; stops at "now".
  _play(on) {
    clearInterval(this._replayTimer);
    if (!this._replay) return;
    this._replay = { ...this._replay, playing: on };
    if (!on) return;
    if (this._replay.t >= this._replay.end) this._seek(this._replay.start);
    this._replayTimer = setInterval(() => {
      const r = this._replay;
      if (!r) return clearInterval(this._replayTimer);
      const next = r.t + 60 * 1000 * 1.25; // 75 s of house per 50 ms tick
      this._seek(next);
      if (next >= r.end) this._play(false);
    }, 50);
  }

  _stopReplay() {
    clearInterval(this._replayTimer);
    this._replay = null;
    this._glowSeen = null;
    this._liveSeen = null;
    this._syncHouse(true);
    this._syncLive(true);
  }

  _replayBar() {
    const r = this._replay;
    const lang = this._config.language || this.hass.locale?.language || 'en';
    const { latitude = 38.7, longitude = -9.1 } = this.hass.config || {};
    const when = new Intl.DateTimeFormat(lang, { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(r.t));
    this._skyTrack ??= skyGradient(r.start, r.end, latitude, longitude);
    return html`<div class="replay">
      <button class="rp-btn" @click=${() => this._play(!r.playing)} ?disabled=${r.loading}>
        <ha-icon icon=${r.playing ? 'mdi:pause' : 'mdi:play'}></ha-icon></button>
      <div class="rp-track">
        <input type="range" min=${r.start} max=${r.end} step="60000" .value=${String(r.t)} ?disabled=${r.loading}
          style="background:${this._skyTrack}" @input=${(e) => { this._play(false); this._seek(Number(e.target.value)); }}>
      </div>
      <span class="rp-time">${r.loading ? this._t.loading : when}</span>
      <button class="rp-live" @click=${() => { this._skyTrack = null; this._stopReplay(); }}>${this._t.live}</button>
    </div>`;
  }

  // Pills that would overlap (small phone screens) are nudged down; ~84×24 px each.
  _spread(labels) {
    const placed = [];
    return [...labels].sort((a, b) => a.y - b.y).map((l) => {
      let y = l.y;
      for (const p of placed) if (Math.abs(p.x - l.x) < 84 && Math.abs(p.y - y) < 24) y = p.y + 24;
      placed.push({ x: l.x, y });
      return { ...l, y };
    });
  }

  // One pill per room: its name (when names are on) plus what's going on in it right now.
  // Room status is pure over hass: compute once per hass object, not on every camera frame.
  _statusOf(level, id) {
    if (this._statusHass !== this.hass) { this._statusHass = this.hass; this._statusMemo = new Map(); }
    const key = `${level.id}/${id}`;
    if (!this._statusMemo.has(key)) this._statusMemo.set(key, roomStatus(this.hass, level, id));
    return this._statusMemo.get(key);
  }

  _roomPill(l) {
    const level = this._plan.levels.find((x) => x.id === l.level);
    const st = this._statusOf(level, l.id);
    const showTemp = st.temp != null && (this._showLabels || this._heat);
    if (!this._showLabels && !st.busy && !showTemp) return nothing;
    const ac = st.acs[0];
    return html`
      <button class="pill ${st.open.length ? 'alert' : ''}" style="left:${l.x}px;top:${l.y}px" @click=${() => this._focus(l.id)}>
        ${this._showLabels ? html`<span class="name">${l.name}</span>` : nothing}
        ${showTemp ? html`<span class=${this._heat ? 'temp' : 'dim'} style=${this._heat ? `color: rgb(${heatColor(st.temp).join(',')})` : ''}>${fmt(st.temp, '°')}</span>` : nothing}
        ${st.lightsOn ? html`<span class="tag lit tap" title=${this._t.roomOff}
          @click=${(e) => { e.stopPropagation(); this._switchLights(this._lampEntities(level, l.id), l.name); }}><ha-icon icon="mdi:lightbulb-on"></ha-icon>${st.lightsOn > 1 ? st.lightsOn : ''}</span>` : nothing}
        ${ac ? html`<span class="tag ${ac.mode === 'heat' ? 'heat' : 'cool'}"><ha-icon icon=${ac.mode === 'heat' ? 'mdi:fire' : ac.mode === 'dry' ? 'mdi:water-percent' : ac.mode === 'fan_only' ? 'mdi:fan' : 'mdi:snowflake'}></ha-icon>${ac.target != null ? fmt(ac.target, '°') : ''}</span>` : nothing}
        ${st.open.length ? html`<span class="tag open"><ha-icon icon=${st.open.some((o) => o.kind === 'door') ? 'mdi:door-open' : 'mdi:window-open-variant'}></ha-icon>${st.open.length > 1 ? st.open.length : ''}</span>` : nothing}
      </button>`;
  }

  _dock() {
    // Once per hass object (and per 30 s, for the countdowns) — not on every camera frame.
    const bucket = Math.floor(Date.now() / 30000);
    if (this._dockHass !== this.hass || this._dockBucket !== bucket) {
      this._dockHass = this.hass;
      this._dockBucket = bucket;
      this._dockMemo = { d: dockStatus(this.hass, this._statusCfg()), apps: appliancesStatus(this.hass, this._config.status?.appliances) };
    }
    const { d, apps } = this._dockMemo;
    // Countdowns move on their own: re-render every 30 s while an appliance is running.
    const running = apps.some((a) => a.phase === 'running');
    if (running && !this._tick) this._tick = setInterval(() => this.requestUpdate(), 30000);
    if (!running && this._tick) { clearInterval(this._tick); this._tick = null; }
    const info = (entity) => () => this._moreInfo(entity);
    return html`
      <div class="dock">
        ${d.weather ? html`<button class="dk" @click=${info(d.weather.entity)}><ha-icon icon=${d.weather.icon}></ha-icon>${fmt(d.weather.temp, '°')}</button>` : nothing}
        ${d.people.length ? html`<span class="dk people">${d.people.map((p) => html`
          <button class="avatar ${p.home ? 'home' : 'away'}" title=${`${p.name} · ${p.home ? this._t.home : this._t.away}`} @click=${info(p.entity)}
            style=${p.picture ? `background-image:url(${p.picture})` : ''}>${p.picture ? '' : p.name.trim()[0]}</button>`)}</span>` : nothing}
        ${d.solar ? html`<button class="dk ${d.solar.value > 0.05 ? 'sun' : ''}" @click=${info(d.solar.entity)}><ha-icon icon="mdi:solar-power-variant"></ha-icon>${fmt(d.solar.value, ` ${d.solar.unit}`)}</button>` : nothing}
        ${d.battery ? html`<button class="dk" @click=${info(d.battery.entity)}><ha-icon icon=${d.battery.value > 80 ? 'mdi:battery-high' : d.battery.value > 30 ? 'mdi:battery-medium' : 'mdi:battery-low'}></ha-icon>${fmt(d.battery.value, '%')}</button>` : nothing}
        ${d.load ? html`<button class="dk" @click=${info(d.load.entity)}><ha-icon icon="mdi:home-lightning-bolt-outline"></ha-icon>${fmt(d.load.value, ` ${d.load.unit}`)}</button>` : nothing}
        ${apps.map((a) => html`
          <button class="dk appliance ${a.phase}" @click=${info(a.entity)}><ha-icon icon=${a.phase === 'done' ? 'mdi:check-circle' : a.icon}></ha-icon>
            ${a.name}${a.phase === 'running' && a.minutes != null ? ` · ${a.minutes} ${this._t.min}` : a.phase === 'done' ? ` · ${this._t.done}` : a.phase === 'error' ? ` · ${this._t.error}` : ''}</button>`)}
      </div>`;
  }

  _roomLightsButton() {
    const level = this._plan.levels.find((l) => l.id === this._room.level);
    const lamps = this._lampEntities(level, this._room.id);
    if (!lamps.length) return nothing;
    const lit = this._litOf(lamps).length;
    return html`<button class="roomlights ${lit ? 'on' : ''}" @click=${() => this._switchLights(lamps, this._room.name)}>
      <ha-icon icon=${lit ? 'mdi:lightbulb-group' : 'mdi:lightbulb-group-outline'}></ha-icon>
      <span>${lit ? this._t.lightsOn(lit, lamps.length) : this._t.allOff}</span><span class="grow"></span><span class="sw">${lit ? this._t.turnOff : this._t.turnOn}</span>
    </button>`;
  }

  _allOff() {
    const all = this._lampEntities();
    const lit = this._litOf(all).length;
    if (!lit) return nothing;
    return html`<button class="chip lit" title=${this._t.everyOff} @click=${() => this._switchLights(all, this._t.house)}>
      <ha-icon icon="mdi:lightbulb-group-off-outline"></ha-icon>${lit}</button>`;
  }

  // status: with the default weather/people resolved once (not a scan of every state per update).
  _statusCfg() {
    const cfg = this._config.status || {};
    if (!this._defaults && this.hass) {
      const ids = Object.keys(this.hass.states);
      this._defaults = { weather: ids.find((e) => e.startsWith('weather.')), people: ids.filter((e) => e.startsWith('person.')) };
    }
    return { ...cfg, weather: cfg.weather ?? this._defaults?.weather, people: cfg.people ?? this._defaults?.people };
  }

  _carChip() {
    const c = carStatus(this.hass, this._config.car);
    if (!c || !this._carAt) return nothing;
    return html`<button class="pill car ${c.charging ? 'charging' : ''}" style="left:${this._carAt.x}px;top:${this._carAt.y}px"
      @click=${() => this._moreInfo(c.entity)}>
      <ha-icon icon=${c.charging ? 'mdi:battery-charging' : 'mdi:car-electric'}></ha-icon>${c.battery != null ? fmt(c.battery, '%') : ''}
    </button>`;
  }

  // Sun + every lamp's house-view glow, only when something they show changed.
  _syncHouse(force = false) {
    if (!this._stage || !this.hass || this._replay) return;
    const sun = this.hass.states[this._config.sun ?? 'sun.sun'];
    if (sun) this._stage.setSun(Number(sun.attributes.elevation ?? -30), Number(sun.attributes.azimuth ?? 180));
    const weather = this.hass.states[this._statusCfg().weather];
    if (weather) this._stage.setWeather(cloudOf(weather.state));
    this._syncHeat();
    const ids = this._glowIds ??= this._stage.glowEntities();
    if (!force && ids.every((e) => this._glowSeen?.get(e) === this.hass.states[e])) return;
    this._glowSeen = new Map(ids.map((e) => [e, this.hass.states[e]]));
    this._stage.applyGlows((cfg) => lampState(this.hass.states[cfg.entity]));
  }

  // Temperature layer: each indoor room's floor tinted by its temperature (when switched on).
  _syncHeat() {
    if (!this._stage) return;
    if (!this._heat) {
      if (this._heatKey !== null) { this._stage.setHeat(null); this._heatKey = null; }
      return;
    }
    const colors = {};
    for (const level of this._plan.levels) {
      for (const r of level.rooms.filter((x) => !x.outdoor)) {
        const group = roomGroup(level, r.id);
        const c = heatColor(roomTemp(this.hass, level, new Set(group.map((g) => g.id)), r.area));
        if (c) colors[r.id] = c;
      }
    }
    const key = JSON.stringify(colors);
    if (key === this._heatKey) return;
    this._heatKey = key;
    this._stage.setHeat(colors);
  }

  _toggleHeat() {
    this._heat = !this._heat;
    writePref('heat', this._heat ? '1' : '0');
    this._syncHeat();
  }

  // Contact sensors on openings and TVs: only when one of them changed.
  _syncLive(force = false) {
    if (!this._stage || !this.hass || this._replay) return;
    const ids = this._liveIds ??= this._stage.liveEntities();
    if (!force && ids.every((e) => this._liveSeen?.get(e) === this.hass.states[e])) return;
    this._liveSeen = new Map(ids.map((e) => [e, this.hass.states[e]]));
    this._stage.applyLive((e) => this.hass.states[e]);
  }

  // Push live state into the focused room's lamps/ACs, only when one of them changed.
  _syncStates() {
    this._syncHouse();
    this._syncLive();
    if (!this._stage || !this._room || !this.hass) return;
    const lv = this._plan.levels.find((l) => l.id === this._room.level);
    const rooms = roomGroup(lv, this._room.id).map((r) => r.id);
    const ids = [...lv.lights, ...lv.acs].filter((d) => rooms.includes(d.room)).map((d) => d.entity).filter(Boolean);
    if (ids.every((e) => this._watched.get(e) === this.hass.states[e])) return;
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
    if (t.kind === 'light') { // room view only: the house view has no lamp tap targets (misclicks)
      haptic();
      this.hass.callService('homeassistant', 'toggle', { entity_id: entity }).catch((e) => this._say(e.message));
    }
    else this._moreInfo(entity);
  }

  _moreInfo(entityId) {
    if (!entityId) return;
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }

  _say(text, action = null, ms = 4000) {
    this._toast = { text, action };
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { this._toast = null; }, ms);
  }

  /* ---------- quick control ---------- */

  _lampEntities(level = null, roomId = null) {
    const levels = level ? [level] : this._plan.levels;
    const ids = roomId ? new Set(roomGroup(level, roomId).map((r) => r.id)) : null;
    return [...new Set(levels.flatMap((l) => l.lights).filter((x) => x.entity && (!ids || ids.has(x.room))).map((x) => x.entity))];
  }

  _litOf(entities) { return entities.filter((e) => isOn(this.hass.states[e])); }

  // Turn off what's on (remembering it in a throwaway scene so it can be undone), or turn
  // everything on when nothing is.
  async _switchLights(entities, label) {
    const lit = this._litOf(entities);
    haptic();
    if (!lit.length) {
      await this.hass.callService('homeassistant', 'turn_on', { entity_id: entities }).catch((e) => this._say(e.message));
      return;
    }
    let undo = null;
    try {
      await this.hass.callService('scene', 'create', { scene_id: 'house_3d_undo', snapshot_entities: lit });
      undo = () => { haptic(); this.hass.callService('scene', 'turn_on', { entity_id: 'scene.house_3d_undo' }); this._toast = null; };
    } catch { /* no undo for users who can't create scenes */ }
    await this.hass.callService('homeassistant', 'turn_off', { entity_id: lit }).catch((e) => this._say(e.message));
    this._say(`${label}: ${this._t.lightsOff(lit.length)}`, undo && { label: this._t.undo, run: undo }, 8000);
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
    if (!room.area) { this._sheet = { room, groups: [], note: this._t.noArea }; return; }
    if (!this.hass.areas?.[room.area]) { this._sheet = { room, groups: [], note: this._t.areaGone }; return; }
    const [helpers, curation] = await Promise.all([window.loadCardHelpers?.(), this._curation()]);
    if (this._room !== room) return;
    const groups = areaGroups(this.hass, room.area, curation).map((g) => ({
      ...g, cards: g.entities.map((e) => this._tile(helpers, e)).filter(Boolean),
    }));
    const keep = new Set(groups.flatMap((g) => g.entities));
    for (const e of [...this._tiles.keys()]) if (!keep.has(e)) this._tiles.delete(e);
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
    const card = findCard(lovelace, (c) => JSON.stringify(c.plan ?? null) === this._planKey) || findCard(lovelace);
    if (!card) throw new Error(`No ${TYPE} found in dashboard "${urlPath}"`);
    const was = this._config.plan?.revision || 0;
    if ((card.plan?.revision || 0) !== was) {
      throw new Error('The plan was changed elsewhere since you opened the editor. Close the editor to load it, then redo your change.');
    }
    card.plan = { ...plan, revision: was + 1 };
    await this.hass.callWS({ type: 'lovelace/config/save', url_path: urlPath === 'lovelace' ? null : urlPath, config: lovelace });
    this.setConfig({ ...this._config, plan: card.plan }); // HA reloads too; don't wait for it
    this._editing = false;
    this._say(this._t.saved);
  }

  /* ---------- lifecycle ---------- */

  updated(changed) {
    // Never build while detached: hass can keep arriving after HA throws the element away.
    if (this._dirty && this.hass && this.isConnected) this._build();
    if (changed.has('hass') && this.hass) {
      this._syncStates();
      // Only the open sheet's tiles get live state.
      for (const g of this._sheet?.groups || []) for (const el of g.cards) el.hass = this.hass;
      if (this._room && this._sheet?.note === this._t.areaGone && this.hass.areas?.[this._room.area]) this._loadSheet();
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
      <div class="wrap ${this._room ? 'has-sheet' : ''} ${this._ambient ? 'ambient' : ''}" style="height:${this._config.height || 'calc(100vh - var(--header-height, 56px) - 16px)'}">
        <div class="stage">
          <div class="canvas"></div>
          ${this._ambient && this.hass ? this._clock() : nothing}
          ${this._room || !this.hass || this._replay ? nothing : this._spread(this._labels).map((l) => this._roomPill(l))}
          ${this._room || !this.hass || this._replay ? nothing : this._carChip()}
          ${this._room || !this.hass ? nothing : this._replay ? this._replayBar() : this._dock()}
          <div class="bar">
            ${this._room ? html`
              <button class="chip back" @click=${() => this._back()}>← ${plan?.name || 'Casa'}</button>
              <span class="title">${this._room.name}</span>` : html`
              <span class="title home">${plan?.name || 'Casa'}</span>
              ${levels.length > 1 ? levels.map((l) => html`
                <button class="chip ${this._peel === l.id ? 'on' : ''}" @click=${() => this._setPeel(l.id)}>${l.name}</button>`) : nothing}`}
            <span class="grow"></span>

            ${!this._room && this.hass && this._plan && !this._replay ? this._allOff() : nothing}
            ${!this._room && this.hass && !this._replay ? html`<button class="chip icon" title=${this._t.replay} @click=${() => this._startReplay()}>
              <ha-icon icon="mdi:history"></ha-icon></button>` : nothing}
            ${this._room ? nothing : html`<button class="chip icon ${this._heat ? 'on' : ''}" title=${this._t.temps}
              @click=${() => this._toggleHeat()}><ha-icon icon="mdi:thermometer"></ha-icon></button>`}
            ${this._room ? nothing : html`<button class="chip icon ${this._showLabels ? 'on' : ''}" title=${this._t.roomNames}
              @click=${() => this._toggleLabels()}>Aa</button>`}
            ${admin ? html`<button class="chip icon" title=${this._t.editHouse} @click=${() => this._openEditor()}>✎</button>` : nothing}
          </div>
          ${this._error ? html`<div class="error"><b>Can't show the house</b><p>${this._error}</p></div>` : nothing}
          ${!this._config.plan && plan && !this._room ? html`<div class="hint">${this._t.starter}</div>` : nothing}
          ${this._away ? html`<button class="fab" title=${this._t.recenter} @click=${() => this._stage?.recenter()}>
            <ha-icon icon="mdi:crosshairs-gps"></ha-icon></button>` : nothing}
          ${this._toast ? html`<div class="toast">${this._toast.text}${this._toast.action ? html`
            <button class="act" @click=${() => this._toast.action.run()}>${this._toast.action.label}</button>` : nothing}</div>` : nothing}
        </div>
        ${this._room ? html`
          <aside class="sheet ${this._sheetBig ? 'big' : ''}">
            <button class="grip" aria-label="Expand" @click=${() => { this._sheetBig = !this._sheetBig; }}></button>
            <header>
              <h2>${this._room.name}</h2>
              ${temp || hum ? html`<span class="climate">${[temp, hum].filter(Boolean).join(' · ')}</span>` : nothing}
            </header>
            ${this._roomLightsButton()}
            ${sheet?.note ? html`<p class="note">${sheet.note}</p>` : nothing}
            ${!sheet ? html`<p class="note">${this._t.loading}</p>` : nothing}
            ${sheet?.groups.map((g) => html`<h3>${this._t[g.key] || g.title}</h3><div class="tiles">${g.cards}</div>`)}
          </aside>` : nothing}
      </div>
      ${this._editing ? html`
        <house-3d-editor .hass=${this._editHass} .plan=${this._editPlan}
          .save=${(p) => this._save(p)} @close=${() => { this._editing = false; }}></house-3d-editor>` : nothing}
    `;
  }

  // The editor works on one copy taken when it opens. Handing it a fresh clone on every
  // render (hass updates re-render the card every few seconds) silently threw edits away.
  _openEditor() {
    this._editPlan = structuredClone(this._rawPlan);
    this._editHass = this.hass;
    this._editing = true;
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
    .pill { position: absolute; transform: translate(-50%, -50%); display: flex; align-items: center; gap: 5px; font: inherit; font-size: 12px;
      color: #fff; background: rgba(10, 14, 26, 0.62); border: 1px solid rgba(255,255,255,0.10); border-radius: 999px; padding: 3px 8px;
      cursor: pointer; white-space: nowrap; backdrop-filter: blur(6px); box-shadow: 0 2px 10px rgba(0,0,0,0.25); }
    .pill:hover { background: rgba(60, 86, 170, 0.8); }
    .pill .name { font-weight: 500; }
    .pill .dim { opacity: 0.7; }
    .pill.alert { border-color: rgba(255, 99, 99, 0.7); }
    .tag { display: inline-flex; align-items: center; gap: 2px; font-weight: 600; }
    .tag ha-icon, .dk ha-icon, .pill ha-icon { --mdc-icon-size: 15px; width: 15px; height: 15px; display: inline-flex; }
    .tag.lit { color: #ffd27a; }
    .pill .temp { font-weight: 700; }
    .chip.icon ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; display: inline-flex; vertical-align: -3px; }
    .tag.cool { color: #7cc4ff; }
    .tag.heat { color: #ff9a5a; }
    .tag.open { color: #ff7b7b; }
    .pill.car { gap: 3px; font-weight: 600; }
    .pill.car.charging { color: #8ef0a8; border-color: rgba(142, 240, 168, 0.6); }
    .dock { position: absolute; left: 10px; bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; max-width: calc(100% - 20px); }
    .dk { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 13px; font-weight: 500; color: #eef1f8;
      background: rgba(10, 14, 26, 0.62); border: 1px solid rgba(255,255,255,0.10); border-radius: 999px; padding: 4px 10px;
      backdrop-filter: blur(6px); cursor: pointer; }
    .dk.sun { color: #ffd27a; }
    .dk.appliance.running { color: #9fd0ff; }
    .dk.appliance.done { color: #8ef0a8; border-color: rgba(142, 240, 168, 0.5); }
    .dk.appliance.error { color: #ff8a8a; border-color: rgba(255, 99, 99, 0.6); }
    .dk.people { gap: 4px; padding: 3px 5px; cursor: default; }
    .avatar { width: 22px; height: 22px; border-radius: 50%; border: 2px solid transparent; font: inherit; font-size: 11px; font-weight: 700;
      color: #0a0e1a; background: #cfd6e6 center/cover; padding: 0; cursor: pointer; }
    .avatar.home { border-color: #6ee7a0; }
    .avatar.away { opacity: 0.45; filter: grayscale(1); }
    .error, .hint, .toast { position: absolute; left: 50%; transform: translateX(-50%); background: rgba(20, 26, 42, 0.92); color: #eef1f8;
      border-radius: 10px; padding: 10px 14px; font-size: 13px; max-width: 80%; }
    .error { top: 30%; border: 1px solid #e05252; }
    .error p { margin: 6px 0 0; white-space: pre-wrap; }
    .hint { bottom: 56px; }
    .toast { display: flex; align-items: center; gap: 12px; }
    .clock { position: absolute; left: 0; right: 0; top: 7%; text-align: center; color: #fff; pointer-events: none;
      text-shadow: 0 2px 18px rgba(0,0,0,0.45); animation: fadein 1.2s ease; }
    .clock .time { font-size: clamp(56px, 12vw, 132px); font-weight: 200; letter-spacing: -0.02em; line-height: 1; font-variant-numeric: tabular-nums; }
    .clock .date { font-size: clamp(16px, 2.4vw, 26px); font-weight: 400; opacity: 0.9; margin-top: 8px; }
    .clock .sub { display: flex; gap: 18px; justify-content: center; margin-top: 10px; font-size: clamp(14px, 1.8vw, 20px); opacity: 0.9; }
    .clock .sub span { display: inline-flex; align-items: center; gap: 6px; }
    .clock ha-icon { --mdc-icon-size: 1.2em; width: 1.2em; height: 1.2em; display: inline-flex; }
    @keyframes fadein { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
    .wrap .bar, .wrap .pill { transition: opacity 0.8s ease; }
    .wrap.ambient .bar, .wrap.ambient .pill, .wrap.ambient .fab { opacity: 0; pointer-events: none; }
    .replay { position: absolute; left: 10px; right: 10px; bottom: 10px; display: flex; align-items: center; gap: 10px; padding: 8px 12px;
      background: rgba(10, 14, 26, 0.78); border: 1px solid rgba(255,255,255,0.12); border-radius: 16px; backdrop-filter: blur(8px); color: #eef1f8; }
    .rp-btn { width: 38px; height: 38px; border-radius: 50%; border: 0; background: #e9eefb; color: #0a0e1a; display: grid; place-items: center; cursor: pointer; flex: none; }
    .rp-btn ha-icon { --mdc-icon-size: 22px; width: 22px; height: 22px; display: inline-flex; }
    .rp-track { flex: 1; min-width: 0; }
    .rp-track input { width: 100%; height: 10px; border-radius: 6px; appearance: none; -webkit-appearance: none; outline: none; margin: 0; }
    .rp-track input::-webkit-slider-thumb { -webkit-appearance: none; width: 22px; height: 22px; border-radius: 50%; background: #fff; border: 3px solid #3b5bdb; box-shadow: 0 2px 6px rgba(0,0,0,0.4); cursor: grab; }
    .rp-track input::-moz-range-thumb { width: 18px; height: 18px; border-radius: 50%; background: #fff; border: 3px solid #3b5bdb; cursor: grab; }
    .rp-time { font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; min-width: 78px; text-align: right; text-transform: capitalize; }
    .rp-live { font: inherit; font-size: 13px; font-weight: 600; color: #8fb3ff; background: none; border: 1px solid rgba(143,179,255,0.4); border-radius: 999px; padding: 5px 12px; cursor: pointer; }
    .fab { position: absolute; right: 12px; top: 58px; width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center;
      color: #eef1f8; background: rgba(10, 14, 26, 0.72); border: 1px solid rgba(255,255,255,0.14); backdrop-filter: blur(6px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.35); cursor: pointer; padding: 0; }
    .fab ha-icon { --mdc-icon-size: 22px; width: 22px; height: 22px; display: inline-flex; }
    .toast .act { font: inherit; font-weight: 600; color: #8fb3ff; background: none; border: 0; cursor: pointer; padding: 2px 4px; }
    .chip.lit { display: inline-flex; align-items: center; gap: 4px; color: #ffd27a; }
    .chip.lit ha-icon { --mdc-icon-size: 16px; width: 16px; height: 16px; display: inline-flex; }
    .tag.tap { cursor: pointer; border-radius: 999px; padding: 1px 3px; margin: -1px -3px; }
    .tag.tap:hover { background: rgba(255, 210, 122, 0.2); }
    .roomlights { display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 14px; color: var(--primary-text-color);
      background: var(--secondary-background-color, #262a33); border: 0; border-radius: 12px; padding: 12px 14px; margin: 4px 0 10px; cursor: pointer; }
    .roomlights.on { background: linear-gradient(90deg, rgba(255, 196, 102, 0.28), rgba(255, 196, 102, 0.1)); }
    .roomlights.on ha-icon { color: #ffc466; }
    .roomlights .sw { font-weight: 600; opacity: 0.8; }
    .toast { bottom: 54px; }
    .sheet { width: 380px; flex: none; overflow-y: auto; background: var(--card-background-color, #1c1f26); padding: 12px 12px 24px; box-sizing: border-box; }
    .sheet header { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .sheet h2 { margin: 4px 0 8px; font-size: 20px; font-weight: 600; color: var(--primary-text-color); }
    .sheet h3 { margin: 14px 2px 6px; font-size: 13px; font-weight: 500; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: 0.04em; }
    .climate { color: var(--secondary-text-color); font-size: 14px; }
    .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .note { color: var(--secondary-text-color); }
    @media (max-width: 500px) {
      .title.home { display: none; }
      .bar { gap: 5px; padding: 8px; }
      .chip { padding: 5px 10px; }
      .dk { font-size: 12px; padding: 3px 8px; }
      .dock { gap: 4px; left: 8px; bottom: 8px; }
    }
    .grip { display: none; }
    @media (max-width: 800px), (orientation: portrait) and (max-width: 1100px) {
      .wrap.has-sheet { flex-direction: column; }
      .wrap.has-sheet .stage { flex: 0 0 50%; transition: flex-basis 0.3s ease; }
      .wrap.has-sheet:has(.sheet.big) .stage { flex-basis: 22%; }
      .sheet { width: auto; flex: 1; border-radius: 18px 18px 0 0; margin-top: -16px; position: relative; z-index: 1;
        box-shadow: 0 -8px 24px rgba(0,0,0,0.35); padding-top: 4px; }
      .grip { display: block; width: 100%; height: 22px; background: none; border: 0; cursor: pointer; position: relative; }
      .grip::after { content: ''; position: absolute; left: 50%; top: 9px; width: 40px; height: 5px; border-radius: 3px;
        transform: translateX(-50%); background: var(--divider-color, rgba(255,255,255,0.25)); }
    }
  `;
}

// A short tick on phones that support it (Android Companion app); silent elsewhere.
function haptic() {
  try { navigator.vibrate?.(12); } catch { /* not supported */ }
}

// Per-viewer UI preferences; storage can be unavailable (private mode, previews).
function readPref(key) {
  try { return localStorage.getItem(`house-3d-card.${key}`); } catch { return null; }
}
function writePref(key, value) {
  try { localStorage.setItem(`house-3d-card.${key}`, value); } catch { /* not persisted */ }
}

function findCard(node, match = () => true) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === TYPE && match(node)) return node;
  for (const v of Object.values(node)) {
    const hit = Array.isArray(v) ? v.map((x) => findCard(x, match)).find(Boolean) : typeof v === 'object' ? findCard(v, match) : null;
    if (hit) return hit;
  }
  return null;
}

customElements.define('house-3d-card', House3DCard);
window.customCards = window.customCards || [];
window.customCards.push({ type: 'house-3d-card', name: 'House 3D', description: 'A live 3D model of your home' });
console.info(`%c HOUSE-3D-CARD %c ${VERSION} `, 'background:#3b5bdb;color:#fff', 'background:#e9eefb;color:#0a0e1a');
