// Full-screen plan editor: storey tabs, a top-down SVG plan (drag to move, corner to resize,
// 5 cm snapping) and an inspector that links rooms to HA areas and lamps/ACs to entities.
// Drag logic adapted from House Control's editor.
import { LitElement, html, svg, css, nothing } from 'lit';
import { normalizePlan, LIGHT_TYPES, INDOOR_FLOORS, OUTDOOR_FLOORS, boundsOf } from './plan.js';
import { FURNITURE_TYPES, footprint } from './three/furniture.js';
import { entitiesFor } from './hass-map.js';

const STEP = 0.05;
const round = (v, s = STEP) => Math.round(v / s) * s;
const fix = (v) => Number(v.toFixed(2));
const KEYS = { room: 'rooms', opening: 'openings', furniture: 'furniture', light: 'lights', ac: 'acs' };
const FILL = {
  oak: '#7a6247', walnut: '#5c4637', tile: '#6f767f', stone: '#5d6169',
  grass: '#3f6a31', deck: '#6a5442', paving: '#7c776d', water: '#2a6f9a',
};
const name = (hass, id) => hass.states[id]?.attributes?.friendly_name || id;

class HouseEditor extends LitElement {
  static properties = {
    hass: { attribute: false },
    plan: { attribute: false },
    save: { attribute: false },
    _lv: { state: true },
    _sel: { state: true },
    _busy: { state: true },
    _msg: { state: true },
  };

  constructor() {
    super();
    this._lv = 0;
    this._sel = null;
    this._undo = [];
    this._onKey = (ev) => this._key(ev);
  }

  connectedCallback() { super.connectedCallback(); window.addEventListener('keydown', this._onKey); }
  disconnectedCallback() { super.disconnectedCallback(); window.removeEventListener('keydown', this._onKey); }

  get level() { return this.plan.levels[this._lv]; }
  _item(sel = this._sel) { return sel ? this.level[KEYS[sel.kind]]?.[sel.index] : null; }

  _snapshot() { this._undo.push(JSON.stringify(this.plan)); if (this._undo.length > 100) this._undo.shift(); }
  _change(fn) { this._snapshot(); fn(); this.requestUpdate(); }
  _undoLast() {
    const prev = this._undo.pop();
    if (!prev) return;
    this.plan = JSON.parse(prev);
    this._lv = Math.min(this._lv, this.plan.levels.length - 1);
    this._sel = null;
  }

  _key(ev) {
    if (ev.target?.closest?.('input, select, textarea') || ev.composedPath().some((n) => ['INPUT', 'SELECT', 'TEXTAREA'].includes(n.tagName))) return;
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') { ev.preventDefault(); this._undoLast(); }
    else if ((ev.key === 'Delete' || ev.key === 'Backspace') && this._sel) { ev.preventDefault(); this._remove(); }
    else if (ev.key === 'Escape') this._sel = null;
  }

  /* ---------- plan geometry ---------- */

  _roomAt([x, z]) {
    return this.level.rooms.find((r) => x >= r.rect[0] && x <= r.rect[0] + r.rect[2] && z >= r.rect[1] && z <= r.rect[1] + r.rect[3]);
  }

  _viewBox() {
    const all = this.plan.levels.flatMap((l) => l.rooms).map((r) => ({ x: r.rect[0], z: r.rect[1], w: r.rect[2], d: r.rect[3] }));
    const b = boundsOf(all);
    const m = 1.5;
    return [b.minX - m, b.minZ - m, b.maxX - b.minX + m * 2, b.maxZ - b.minZ + m * 2];
  }

  // Screen pixels per plan metre (the SVG letterboxes the viewBox: preserveAspectRatio meet).
  _pxPerMetre(vb) {
    const r = this.renderRoot.querySelector('svg.plan')?.getBoundingClientRect();
    if (!r?.width) return 30;
    return Math.min(r.width / vb[2], r.height / vb[3]);
  }

  _point(ev) {
    const el = this.renderRoot.querySelector('svg.plan');
    const pt = el.createSVGPoint();
    pt.x = ev.clientX;
    pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM().inverse());
    return [p.x, p.y];
  }

  _snapAC(ac, [x, z]) {
    const room = this._roomAt([x, z]) || this.level.rooms.find((r) => r.id === ac.room);
    if (!room) return;
    const [rx, rz, rw, rd] = room.rect;
    const wall = [['north', Math.abs(z - rz)], ['south', Math.abs(z - (rz + rd))], ['west', Math.abs(x - rx)], ['east', Math.abs(x - (rx + rw))]]
      .sort((p, q) => p[1] - q[1])[0][0];
    const cx = fix(Math.min(Math.max(round(x), rx + 0.6), rx + rw - 0.6));
    const cz = fix(Math.min(Math.max(round(z), rz + 0.6), rz + rd - 0.6));
    ac.room = room.id;
    ac.wall = wall;
    ac.pos = wall === 'north' ? [cx, rz] : wall === 'south' ? [cx, fix(rz + rd)] : wall === 'west' ? [rx, cz] : [fix(rx + rw), cz];
  }

  // A dragged door/window sticks to the nearest wall line within 40 cm.
  _snapOpening(o) {
    const horizontal = o.from[1] === o.to[1];
    const c = horizontal ? o.from[1] : o.from[0];
    const lines = this.level.rooms.flatMap((r) => (horizontal ? [r.rect[1], r.rect[1] + r.rect[3]] : [r.rect[0], r.rect[0] + r.rect[2]]));
    const best = lines.sort((a, b) => Math.abs(a - c) - Math.abs(b - c))[0];
    if (best == null || Math.abs(best - c) > 0.4) return;
    if (horizontal) { o.from[1] = fix(best); o.to[1] = fix(best); } else { o.from[0] = fix(best); o.to[0] = fix(best); }
  }

  _down(ev) {
    const el = ev.target.closest('[data-kind]');
    const kind = el?.dataset.kind;
    if (!kind) { this._sel = null; return; }
    const index = Number(el.dataset.index);
    const start = this._point(ev);
    ev.currentTarget.setPointerCapture(ev.pointerId);
    const vb = this._viewBox();
    if (kind === 'resize') { this._drag = { kind, index, start, rect: [...this.level.rooms[index].rect], vb }; return; }
    this._sel = { kind, index };
    const item = this._item();
    const drag = { kind, index, start, moved: false, vb };
    if (kind === 'room') {
      const [x, z, w, d] = item.rect;
      const inside = ([px, pz]) => px >= x - 1e-6 && px <= x + w + 1e-6 && pz >= z - 1e-6 && pz <= z + d + 1e-6;
      drag.rect = [...item.rect];
      drag.riders = [
        ...this.level.lights.filter((l) => l.room === item.id),
        ...this.level.acs.filter((a) => a.room === item.id),
        ...this.level.furniture.filter((f) => Array.isArray(f.pos) && inside(f.pos)),
      ].map((o) => ({ o, pos: [...o.pos] }));
      drag.openings = this.level.openings.filter((o) => inside(o.from) && inside(o.to)).map((o) => ({ o, from: [...o.from], to: [...o.to] }));
    } else if (kind === 'opening') {
      drag.from = [...item.from];
      drag.to = [...item.to];
    } else {
      drag.pos = [...item.pos];
    }
    this._drag = drag;
  }

  _move(ev) {
    const drag = this._drag;
    if (!drag) return;
    const [px, pz] = this._point(ev);
    const dx = round(px - drag.start[0]);
    const dz = round(pz - drag.start[1]);
    if (!drag.moved && !dx && !dz) return;
    if (!drag.moved) { drag.moved = true; this._snapshot(); }
    const lv = this.level;
    if (drag.kind === 'resize') {
      const r = lv.rooms[drag.index];
      r.rect[2] = fix(Math.max(0.5, round(drag.rect[2] + px - drag.start[0])));
      r.rect[3] = fix(Math.max(0.5, round(drag.rect[3] + pz - drag.start[1])));
    } else if (drag.kind === 'room') {
      const r = lv.rooms[drag.index];
      r.rect[0] = fix(drag.rect[0] + dx);
      r.rect[1] = fix(drag.rect[1] + dz);
      for (const x of drag.riders) x.o.pos = [fix(x.pos[0] + dx), fix(x.pos[1] + dz)];
      for (const x of drag.openings) {
        x.o.from = [fix(x.from[0] + dx), fix(x.from[1] + dz)];
        x.o.to = [fix(x.to[0] + dx), fix(x.to[1] + dz)];
      }
    } else if (drag.kind === 'opening') {
      const o = lv.openings[drag.index];
      o.from = [fix(drag.from[0] + dx), fix(drag.from[1] + dz)];
      o.to = [fix(drag.to[0] + dx), fix(drag.to[1] + dz)];
      this._snapOpening(o);
    } else if (drag.kind === 'ac') {
      this._snapAC(lv.acs[drag.index], [px, pz]);
    } else {
      const item = lv[KEYS[drag.kind]][drag.index];
      item.pos = [fix(drag.pos[0] + dx), fix(drag.pos[1] + dz)];
      if (drag.kind === 'light') { const room = this._roomAt(item.pos); if (room) item.room = room.id; }
    }
    this.requestUpdate();
  }

  _up() { this._drag = null; }

  /* ---------- editing actions ---------- */

  _uniqueRoomId(base) {
    const used = new Set(this.plan.levels.flatMap((l) => l.rooms.map((r) => r.id)));
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  _addRoom(area) {
    const b = boundsOf(this.level.rooms.map((r) => ({ x: r.rect[0], z: r.rect[1], w: r.rect[2], d: r.rect[3] })));
    const outdoor = /ext|outdoor|garden|jardim/i.test(`${area?.floor_id || ''} ${this.hass.floors?.[area?.floor_id]?.name || ''}`);
    this._change(() => {
      this.level.rooms.push({
        id: this._uniqueRoomId(area?.area_id || 'room'), name: area?.name || 'Room', area: area?.area_id || null,
        rect: [fix(this.level.rooms.length ? b.maxX + 0.5 : 0), fix(this.level.rooms.length ? b.minZ : 0), 4, 4],
        ...(outdoor ? { outdoor: true, floor: 'grass' } : { floor: 'oak' }),
      });
      this._sel = { kind: 'room', index: this.level.rooms.length - 1 };
    });
  }

  _addInRoom(kind, extra = {}) {
    const room = this._item();
    const [x, z, w, d] = room.rect;
    const c = [fix(round(x + w / 2)), fix(round(z + d / 2))];
    this._change(() => {
      const lv = this.level;
      if (kind === 'light') lv.lights.push({ room: room.id, type: 'ceiling', pos: c, ...extra });
      if (kind === 'ac') { const ac = { room: room.id, ...extra }; this._snapAC(ac, [c[0], z]); lv.acs.push(ac); }
      if (kind === 'furniture') lv.furniture.push({ type: extra.type, pos: c, rot: 0 });
      if (kind === 'opening') {
        const len = extra.type === 'window' ? 1.2 : 0.9;
        const wall = extra.wall || 'south';
        const mid = wall === 'north' || wall === 'south' ? c[0] : c[1];
        const at = { north: z, south: fix(z + d), west: x, east: fix(x + w) }[wall];
        const [a, b] = [fix(mid - len / 2), fix(mid + len / 2)];
        lv.openings.push(wall === 'north' || wall === 'south'
          ? { type: extra.type, from: [a, at], to: [b, at] } : { type: extra.type, from: [at, a], to: [at, b] });
      }
      const key = KEYS[kind];
      this._sel = { kind, index: lv[key].length - 1 };
    });
  }

  _remove() {
    const sel = this._sel;
    if (!sel) return;
    this._change(() => {
      const lv = this.level;
      if (sel.kind === 'room') {
        const id = lv.rooms[sel.index].id;
        lv.lights = lv.lights.filter((l) => l.room !== id);
        lv.acs = lv.acs.filter((a) => a.room !== id);
      }
      lv[KEYS[sel.kind]].splice(sel.index, 1);
      this._sel = null;
    });
  }

  _moveRoomToLevel(target) {
    const room = this._item();
    this._change(() => {
      const from = this.level;
      const to = this.plan.levels[target];
      to.rooms.push(room);
      from.rooms.splice(this._sel.index, 1);
      for (const key of ['lights', 'acs']) {
        to[key].push(...from[key].filter((x) => x.room === room.id));
        from[key] = from[key].filter((x) => x.room !== room.id);
      }
      this._lv = target;
      this._sel = { kind: 'room', index: to.rooms.length - 1 };
    });
  }

  _addLevel() {
    this._change(() => {
      const n = this.plan.levels.length;
      this.plan.levels.push({ id: `level${n}`, name: `Piso ${n}`, rooms: [], openings: [], furniture: [], lights: [], acs: [] });
      this._lv = n;
      this._sel = null;
    });
  }

  async _save() {
    try {
      normalizePlan(this.plan);
    } catch (e) {
      this._msg = { bad: true, text: e.message };
      return;
    }
    this._busy = true;
    try {
      await this.save(this.plan);
    } catch (e) {
      this._msg = { bad: true, text: e.message };
    } finally {
      this._busy = false;
    }
  }

  _close() {
    if (this._undo.length && !confirm('Discard your changes?')) return;
    this.dispatchEvent(new CustomEvent('close'));
  }

  /* ---------- render ---------- */

  _field(label, value, set, { type = 'text', step } = {}) {
    return html`<label>${label}<input type=${type} step=${step ?? nothing} .value=${String(value ?? '')}
      @change=${(e) => this._change(() => set(type === 'number' ? Number(e.target.value) : e.target.value))}></label>`;
  }

  _select(label, value, options, set) {
    return html`<label>${label}<select @change=${(e) => this._change(() => set(e.target.value || null))}>
      ${options.map(([v, t]) => html`<option value=${v ?? ''} ?selected=${(v ?? '') === (value ?? '')}>${t}</option>`)}
    </select></label>`;
  }

  _entityOptions(domains, area, filter) {
    const { inArea, rest } = entitiesFor(this.hass, domains, area);
    const keep = (xs) => (filter ? xs.filter(filter) : xs);
    return [[null, '— none —'], ...keep(inArea).map((e) => [e, `★ ${name(this.hass, e)}`]), ...keep(rest).map((e) => [e, name(this.hass, e)])];
  }

  _placedEntities() {
    return new Set(this.plan.levels.flatMap((l) => [...l.lights, ...l.acs].map((d) => d.entity)).filter(Boolean));
  }

  _inspector() {
    const sel = this._sel;
    const item = this._item();
    const lv = this.level;
    const areas = Object.values(this.hass.areas || {});
    if (!item) {
      const placed = new Set(this.plan.levels.flatMap((l) => l.rooms.map((r) => r.area)));
      const unplaced = areas.filter((a) => !placed.has(a.area_id))
        .sort((a, b) => (b.floor_id === lv.floor) - (a.floor_id === lv.floor) || a.name.localeCompare(b.name));
      return html`
        <h3>Storey</h3>
        ${this._field('Name', lv.name, (v) => { lv.name = v; })}
        ${this._field('Elevation (m)', lv.elevation ?? '', (v) => { lv.elevation = v === 0 && this._lv > 0 ? undefined : v; }, { type: 'number', step: 0.05 })}
        ${this._select('HA floor', lv.floor, [[null, '—'], ...Object.values(this.hass.floors || {}).map((f) => [f.floor_id, f.name])], (v) => { lv.floor = v; })}
        <h3>Add room</h3>
        <div class="list">
          ${unplaced.map((a) => html`<button @click=${() => this._addRoom(a)}>+ ${a.name}
            <small>${this.hass.floors?.[a.floor_id]?.name || ''}</small></button>`)}
          <button @click=${() => this._addRoom(null)}>+ Room without area</button>
        </div>
        <p class="help">Drag rooms to move them, drag the corner dot to resize. Rooms that touch share a wall.
          Select a room to add doors, windows, lamps, ACs and furniture.</p>`;
    }
    const del = html`<button class="danger" @click=${() => this._remove()}>Delete</button>`;
    if (sel.kind === 'room') {
      const placed = this._placedEntities();
      const lamps = entitiesFor(this.hass, ['light', 'switch'], item.area).inArea.filter((e) => !placed.has(e));
      const acs = entitiesFor(this.hass, ['climate'], item.area).inArea.filter((e) => !placed.has(e));
      const floors = item.outdoor ? OUTDOOR_FLOORS : INDOOR_FLOORS;
      return html`
        <h3>Room</h3>
        ${this._field('Name', item.name, (v) => { item.name = v; })}
        ${this._select('HA area', item.area, [[null, '—'], ...areas.map((a) => [a.area_id, a.name])], (v) => {
          item.area = v;
          if (v && (!item.name || item.name === 'Room')) item.name = this.hass.areas[v].name;
        })}
        <label class="check"><input type="checkbox" .checked=${Boolean(item.outdoor)}
          @change=${(e) => this._change(() => { item.outdoor = e.target.checked; item.floor = e.target.checked ? 'grass' : 'oak'; })}> Outdoor (no walls)</label>
        ${this._select('Ground', item.floor, floors.map((f) => [f, f]), (v) => { item.floor = v; })}
        <div class="row">
          ${this._field('Width', item.rect[2], (v) => { item.rect[2] = v; }, { type: 'number', step: STEP })}
          ${this._field('Depth', item.rect[3], (v) => { item.rect[3] = v; }, { type: 'number', step: STEP })}
          ${this._field('Rotation°', item.rot ?? 0, (v) => { item.rot = v || undefined; }, { type: 'number', step: 15 })}
        </div>
        <p class="help">Rooms sharing an HA area act as one room (L-shapes): no wall between them, one label.</p>
        ${this.plan.levels.length > 1 ? this._select('Storey', String(this._lv), this.plan.levels.map((l, i) => [String(i), l.name]),
          (v) => { this._undo.pop(); this._moveRoomToLevel(Number(v)); }) : nothing}
        <h3>Add to room</h3>
        <div class="list">
          ${lamps.map((e) => html`<button @click=${() => this._addInRoom('light', { entity: e })}>💡 ${name(this.hass, e)}</button>`)}
          <button @click=${() => this._addInRoom('light', {})}>💡 Lamp (not linked)</button>
          ${acs.map((e) => html`<button @click=${() => this._addInRoom('ac', { entity: e })}>❄ ${name(this.hass, e)}</button>`)}
          ${item.outdoor ? nothing : html`
            <div class="row">
              ${['door', 'window', 'open'].map((t) => html`<button @click=${() => this._addInRoom('opening', { type: t, wall: this._wall || 'south' })}>+ ${t}</button>`)}
              <select @change=${(e) => { this._wall = e.target.value; }}>
                ${['south', 'north', 'east', 'west'].map((w) => html`<option ?selected=${(this._wall || 'south') === w}>${w}</option>`)}
              </select>
            </div>`}
          <div class="row">
            <select id="furn">${FURNITURE_TYPES.map((t) => html`<option>${t}</option>`)}</select>
            <button @click=${() => this._addInRoom('furniture', { type: this.renderRoot.querySelector('#furn').value })}>+ furniture</button>
          </div>
        </div>
        ${del}`;
    }
    if (sel.kind === 'light') {
      const room = lv.rooms.find((r) => r.id === item.room);
      return html`
        <h3>Lamp</h3>
        ${this._select('Entity', item.entity, this._entityOptions(['light', 'switch'], room?.area), (v) => { item.entity = v; })}
        ${this._field('Name', item.name, (v) => { item.name = v; })}
        ${this._select('Type', item.type, LIGHT_TYPES.map((t) => [t, t]), (v) => { item.type = v; })}
        <div class="row">
          ${this._field('Rotation°', item.rot ?? 0, (v) => { item.rot = v; }, { type: 'number', step: 15 })}
          ${this._field('Height (m)', item.y ?? '', (v) => { item.y = v || undefined; }, { type: 'number', step: 0.05 })}
        </div>
        ${item.type === 'strip' ? this._field('Length (m)', item.length ?? 1, (v) => { item.length = v; }, { type: 'number', step: STEP }) : nothing}
        ${del}`;
    }
    if (sel.kind === 'ac') {
      const room = lv.rooms.find((r) => r.id === item.room);
      const isTemp = (e) => this.hass.states[e]?.attributes?.device_class === 'temperature';
      return html`
        <h3>Air conditioner</h3>
        ${this._select('Entity', item.entity, this._entityOptions(['climate'], room?.area), (v) => { item.entity = v; })}
        ${this._select('Room sensor', item.sensor, this._entityOptions(['sensor'], room?.area, isTemp), (v) => { item.sensor = v; })}
        <p class="help">On the ${item.wall} wall — drag it along any wall.</p>
        ${del}`;
    }
    if (sel.kind === 'opening') {
      const horizontal = item.from[1] === item.to[1];
      const len = fix(Math.abs(horizontal ? item.to[0] - item.from[0] : item.to[1] - item.from[1]));
      const setLen = (v) => {
        const i = horizontal ? 0 : 1;
        const mid = (item.from[i] + item.to[i]) / 2;
        item.from[i] = fix(mid - v / 2);
        item.to[i] = fix(mid + v / 2);
      };
      const rotate = () => this._change(() => {
        const [cx, cz] = [(item.from[0] + item.to[0]) / 2, (item.from[1] + item.to[1]) / 2];
        item.from = horizontal ? [fix(cx), fix(cz - len / 2)] : [fix(cx - len / 2), fix(cz)];
        item.to = horizontal ? [fix(cx), fix(cz + len / 2)] : [fix(cx + len / 2), fix(cz)];
      });
      return html`
        <h3>Opening</h3>
        ${this._select('Type', item.type, [['door', 'door'], ['window', 'window'], ['open', 'opening (no door)']], (v) => { item.type = v; })}
        ${this._field('Length (m)', len, setLen, { type: 'number', step: STEP })}
        ${item.type === 'window' ? html`<div class="row">
          ${this._field('Sill', item.sill ?? 0.85, (v) => { item.sill = v; }, { type: 'number', step: STEP })}
          ${this._field('Head', item.head ?? 2.1, (v) => { item.head = v; }, { type: 'number', step: STEP })}</div>` : nothing}
        <button @click=${rotate}>Rotate 90°</button>
        ${del}`;
    }
    if (sel.kind === 'furniture') {
      return html`
        <h3>Furniture</h3>
        ${this._select('Type', item.type, FURNITURE_TYPES.map((t) => [t, t]), (v) => { item.type = v; })}
        <div class="row">
          ${this._field('Rotation°', item.rot ?? 0, (v) => { item.rot = v; }, { type: 'number', step: 90 })}
          ${this._field('Width', item.width ?? '', (v) => { item.width = v || undefined; }, { type: 'number', step: STEP })}
        </div>
        ${this._field('Colour', item.color ?? '#8b93a7', (v) => { item.color = v; }, { type: 'color' })}
        ${this._field('Scale', item.scale ?? 1, (v) => { item.scale = v && v !== 1 ? v : undefined; }, { type: 'number', step: 0.05 })}
        ${del}`;
    }
    return nothing;
  }

  _planSvg() {
    const lv = this.level;
    const vb = this._drag?.vb || this._viewBox();
    const isSel = (k, i) => this._sel?.kind === k && this._sel.index === i;
    const below = this.plan.levels.filter((l, i) => i !== this._lv && (l.elevation ?? i) < (lv.elevation ?? this._lv));
    return svg`
      <defs><pattern id="grid" width="1" height="1" patternUnits="userSpaceOnUse">
        <path d="M1 0H0V1" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="0.015"/></pattern></defs>
      <rect x=${vb[0] - 50} y=${vb[1] - 50} width="200" height="200" fill="url(#grid)"/>
      ${below.flatMap((l) => l.rooms).map((r) => svg`<rect class="ghost" x=${r.rect[0]} y=${r.rect[1]} width=${r.rect[2]} height=${r.rect[3]}/>`)}
      ${lv.rooms.map((r, i) => [r, i]).sort(([a], [b]) => Boolean(a.rot) - Boolean(b.rot)).map(([r, i]) => {
        const [x, z, w, d] = r.rect;
        return svg`<g class="room ${isSel('room', i) ? 'sel' : ''} ${r.outdoor ? 'out' : ''}" data-kind="room" data-index=${i}
          transform=${r.rot ? `rotate(${-r.rot} ${x + w / 2} ${z + d / 2})` : ''}>
          <rect x=${x} y=${z} width=${w} height=${d} fill=${FILL[r.floor] || FILL.oak}/>
          <text x=${x + w / 2} y=${z + d / 2} class="lbl">${r.name}</text>
          <text x=${x + w / 2} y=${z + d / 2 + 0.38} class="dim">${fix(w)} × ${fix(d)}${r.area ? '' : ' · no area'}</text></g>`;
      })}
      ${lv.furniture.map((f, i) => {
        if (!Array.isArray(f.pos)) return nothing;
        const [w, d] = footprint(f);
        return svg`<g class="furn ${isSel('furniture', i) ? 'sel' : ''}" data-kind="furniture" data-index=${i}
          transform="translate(${f.pos[0]} ${f.pos[1]}) rotate(${-(f.rot || 0)})">
          <rect x=${-w / 2} y=${-d / 2} width=${w} height=${d} rx="0.06"/><path d="M${-w / 4} ${d / 2}H${w / 4}" class="front"/></g>`;
      })}
      ${lv.openings.map((o, i) => svg`<line class="open ${o.type} ${isSel('opening', i) ? 'sel' : ''}" data-kind="opening" data-index=${i}
        x1=${o.from[0]} y1=${o.from[1]} x2=${o.to[0]} y2=${o.to[1]}/>`)}
      ${lv.acs.map((a, i) => svg`<g class="ac ${isSel('ac', i) ? 'sel' : ''} ${a.entity ? 'linked' : ''}" data-kind="ac" data-index=${i}
        transform="translate(${a.pos[0]} ${a.pos[1]}) rotate(${{ north: 0, east: 90, south: 180, west: 270 }[a.wall] || 0})">
        <rect x="-0.47" y="0.06" width="0.94" height="0.24" rx="0.07"/></g>`)}
      ${lv.lights.map((l, i) => svg`<g class="light ${isSel('light', i) ? 'sel' : ''} ${l.entity ? 'linked' : ''}" data-kind="light" data-index=${i}
        transform="translate(${l.pos[0]} ${l.pos[1]}) rotate(${-(l.rot || 0)})">
        ${l.type === 'strip' ? svg`<rect x=${-(l.length || 1) / 2} y="-0.07" width=${l.length || 1} height="0.14" rx="0.07"/>`
          : svg`<circle r="0.3" class="halo"/><circle r="0.17"/>`}</g>`)}
      ${this._sel?.kind === 'room' && lv.rooms[this._sel.index] && !lv.rooms[this._sel.index].rot ? (() => {
        const [x, z, w, d] = lv.rooms[this._sel.index].rect;
        // Sized in screen pixels, not metres: on a phone the whole plot is ~14 px/m, so a
        // metre-sized dot was too small to grab. Invisible 22 px finger target + 8 px dot.
        const m = 1 / this._pxPerMetre(vb);
        return svg`<circle class="handle-hit" cx=${x + w} cy=${z + d} r=${22 * m} data-kind="resize" data-index=${this._sel.index}/>
          <circle class="handle" cx=${x + w} cy=${z + d} r=${8 * m} stroke-width=${2 * m} data-kind="resize" data-index=${this._sel.index}/>`;
      })() : nothing}`;
  }

  render() {
    if (!this.plan) return nothing;
    const vb = this._drag?.vb || this._viewBox();
    return html`
      <div class="ed">
        <header>
          <div class="tabs">
            ${this.plan.levels.map((l, i) => html`<button class=${i === this._lv ? 'on' : ''} @click=${() => { this._lv = i; this._sel = null; }}>${l.name}</button>`)}
            <button title="Add storey" @click=${() => this._addLevel()}>+</button>
          </div>
          <span class="grow"></span>
          ${this._msg ? html`<span class="msg ${this._msg.bad ? 'bad' : ''}">${this._msg.text}</span>` : nothing}
          <button ?disabled=${!this._undo.length} @click=${() => this._undoLast()}>Undo</button>
          <button @click=${() => this._close()}>Cancel</button>
          <button class="primary" ?disabled=${this._busy} @click=${() => this._save()}>${this._busy ? 'Saving…' : 'Save'}</button>
        </header>
        <main>
          <svg class="plan" viewBox=${vb.join(' ')} @pointerdown=${(e) => this._down(e)} @pointermove=${(e) => this._move(e)}
            @pointerup=${() => this._up()} @pointercancel=${() => this._up()}>${this._planSvg()}</svg>
          <aside>${this._inspector()}</aside>
        </main>
      </div>`;
  }

  static styles = css`
    .ed { position: fixed; inset: 0; z-index: 9; display: flex; flex-direction: column; background: #0d1220; color: #e6eaf3;
      font-family: var(--ha-font-family-body, Roboto, sans-serif); font-size: 14px; }
    header { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #222a3d; flex-wrap: wrap; }
    .tabs { display: flex; gap: 4px; }
    button, select, input { font: inherit; color: inherit; background: #1a2135; border: 1px solid #2c3550; border-radius: 8px; padding: 6px 10px; }
    button { cursor: pointer; }
    button:disabled { opacity: 0.45; cursor: default; }
    .tabs button.on, button.primary { background: #3b5bdb; border-color: #3b5bdb; color: #fff; }
    button.danger { margin-top: 16px; border-color: #7a2e2e; color: #ff9b9b; }
    .grow { flex: 1; }
    .msg { font-size: 13px; color: #9fd49f; max-width: 50%; }
    .msg.bad { color: #ff9b9b; }
    main { flex: 1; display: flex; min-height: 0; }
    svg.plan { flex: 1; min-width: 0; height: 100%; touch-action: none; user-select: none; }
    aside { width: 320px; overflow-y: auto; padding: 8px 14px 24px; border-left: 1px solid #222a3d; box-sizing: border-box; }
    h3 { margin: 16px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: #8f9bb8; }
    label { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; font-size: 12px; color: #a9b3cb; }
    label input, label select { font-size: 14px; color: #e6eaf3; width: 100%; box-sizing: border-box; min-width: 0; }
    label.check { flex-direction: row; align-items: center; gap: 8px; }
    .row { display: flex; gap: 8px; align-items: flex-end; }
    .row > * { flex: 1; }
    .list { display: flex; flex-direction: column; gap: 6px; }
    .list button { text-align: left; }
    .list small { color: #7f8aa6; margin-left: 6px; }
    .help { color: #8f9bb8; font-size: 12px; line-height: 1.5; }
    .ghost { fill: none; stroke: rgba(255,255,255,0.18); stroke-width: 0.03; stroke-dasharray: 0.15 0.1; pointer-events: none; }
    .room rect { stroke: #cfd6e6; stroke-width: 0.06; cursor: move; }
    .room.out rect { stroke-dasharray: 0.2 0.12; stroke-width: 0.04; }
    .room.sel rect { stroke: #6f8cff; stroke-width: 0.09; }
    .lbl { font-size: 0.42px; fill: #fff; text-anchor: middle; pointer-events: none; font-weight: 600; }
    .dim { font-size: 0.28px; fill: rgba(255,255,255,0.65); text-anchor: middle; pointer-events: none; }
    .furn rect { fill: rgba(255,255,255,0.14); stroke: rgba(255,255,255,0.4); stroke-width: 0.025; cursor: move; }
    .furn .front { stroke: #ffd27a; stroke-width: 0.05; }
    .furn.sel rect { stroke: #6f8cff; stroke-width: 0.05; }
    .open { stroke-width: 0.22; stroke-linecap: butt; cursor: move; }
    .open.door { stroke: #e0a060; } .open.window { stroke: #7cc4ff; } .open.open { stroke: #9aa3b5; stroke-dasharray: 0.1 0.08; }
    .open.sel { stroke: #6f8cff; }
    .ac rect { fill: #e9edf5; stroke: #555; stroke-width: 0.02; cursor: move; }
    .ac:not(.linked) rect { fill: #8a8f9a; }
    .ac.sel rect { stroke: #6f8cff; stroke-width: 0.06; }
    .light circle, .light rect { fill: #ffd27a; cursor: move; }
    .light:not(.linked) circle, .light:not(.linked) rect { fill: #9a8a6a; }
    .light .halo { fill: rgba(255, 210, 122, 0.22); }
    .light.sel circle:not(.halo), .light.sel rect { stroke: #6f8cff; stroke-width: 0.06; }
    .handle { fill: #6f8cff; stroke: #fff; cursor: nwse-resize; }
    .handle-hit { fill: transparent; cursor: nwse-resize; }
    @media (max-width: 700px) { main { flex-direction: column; } aside { width: auto; height: 45%; border-left: 0; border-top: 1px solid #222a3d; } }
  `;
}

customElements.define('house-3d-editor', HouseEditor);
