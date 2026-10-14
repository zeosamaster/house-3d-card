// "Time machine": the last 24 h of the house from HA's recorder — which lamps were on, which
// doors/windows were open, whether the TV played — plus where the sun was, computed from the
// home's latitude/longitude so no sun history is needed.

/** Low-precision solar position (Astronomical Almanac approximation, ~0.5°). */
export function sunPosition(ms, lat, lon) {
  const r = Math.PI / 180;
  const d = ms / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * r;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * r;
  const e = (23.439 - 0.00000036 * d) * r;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
  const ha = (gmst * 15 + lon) * r - ra;
  const la = lat * r;
  const el = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const az = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation: el / r, azimuth: ((az / r) + 360) % 360 };
}

/**
 * The state history of `entities` between `start` and `end` (ms), as
 * Map(entity → [[timeMs, state], ...]) sorted by time; the first entry is the state at `start`.
 */
export async function loadHistory(hass, entities, start, end) {
  const res = await hass.callWS({
    type: 'history/history_during_period',
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    entity_ids: entities,
    minimal_response: true,
    no_attributes: true,
    significant_changes_only: false,
  });
  const out = new Map();
  for (const [id, rows] of Object.entries(res || {})) {
    out.set(id, rows.map((x) => [((x.lc ?? x.lu) || start / 1000) * 1000, x.s]).sort((a, b) => a[0] - b[0]));
  }
  return out;
}

/** The state of `entity` at time `t` from loadHistory's map (undefined when unknown). */
export function stateAt(history, entity, t) {
  const rows = history.get(entity);
  if (!rows?.length) return undefined;
  let lo = 0;
  let hi = rows.length - 1;
  if (t < rows[0][0]) return rows[0][1];
  while (lo < hi) { // last row with time <= t
    const mid = (lo + hi + 1) >> 1;
    if (rows[mid][0] <= t) lo = mid; else hi = mid - 1;
  }
  return rows[lo][1];
}

/** A CSS linear-gradient of the sky over [start, end] — the replay timeline's track. */
export function skyGradient(start, end, lat, lon) {
  const stops = [];
  for (let i = 0; i <= 24; i++) {
    const t = start + ((end - start) * i) / 24;
    const el = sunPosition(t, lat, lon).elevation;
    const c = el > 6 ? '#8ec5ff' : el > 0 ? '#f2b27a' : el > -6 ? '#5a5594' : '#1b2140';
    stops.push(`${c} ${((i / 24) * 100).toFixed(1)}%`);
  }
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
