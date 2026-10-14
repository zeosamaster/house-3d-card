# House 3D Card

A live 3D model of your home for Home Assistant. See the whole house (every storey and the garden), tap a room to fly into it: its lamps glow with their real state, its ACs blow air, and a side sheet shows every device in that HA area as Home Assistant's own tile cards.

The 3D modelling kit (rooms, walls, furniture, lamps, ACs) comes from [House Control](https://github.com/0xProbabillity/house-control) by 0xProbability (MIT).

## Install (HACS)

1. HACS → ⋮ → **Custom repositories** → `zeosamaster/house-3d-card`, type **Dashboard**.
2. Download **House 3D Card**, then hard-refresh the browser.
3. Make a dashboard with one **panel** view holding the card:

```yaml
views:
  - title: Casa
    path: casa
    type: panel
    cards:
      - type: custom:house-3d-card
```

With no `plan` yet, the card lays out a rough starter house from your HA floors and areas. Tap **✎** (admins only) to arrange it.

## Using it

| Do this | To get this |
| --- | --- |
| Tap a room (or its label) | Fly into it; its devices open in the side sheet |
| Room pills | Show up when something's going on: lights on, AC running (mode + target), a door/window open (red) |
| Dock (bottom) | Weather, who's home, solar / battery / house load — tap for details |
| 💡 *n* (top bar) | Every light off at once — **Undo** in the toast brings back exactly what was on (a throwaway `scene.house_3d_undo` snapshot) |
| 💡 in a room pill | That room's lights off (with Undo) |
| Lights bar in a room's sheet | All of the room's lamps on / off |
| Storey chips | Pick the storey to show (starts on the ground floor; the top one shows the whole house) |
| **Aa** | Show / hide room names (off by default, remembered per device) |
| 🌧 | Alive: trees sway with the weather entity's real wind speed, the pool's surface drifts, and when HA says it rains, rain falls on the garden (not through the open rooms). Honours *reduce motion* |
| ⏱ | Time machine: replays the last 24 h in ~24 s — lamps, open doors/windows and TVs from HA's recorder, and the sun moving across the sky (computed from the home's location). Scrub the timeline (its track is the day's sky), **Live** returns |
| 🌡 | Temperature layer: every room's floor tinted cold-blue → comfortable-green → amber → hot-red, temperatures in the pills (area's temperature sensor, else any in the area, else its AC's reading; outdoors only an explicitly chosen area sensor) |
| Tap a lamp in a room | Toggle it |
| Long-press a lamp / tap an AC | Home Assistant's device dialog |
| `← Casa`, Back | Back to the whole house (the room is in the URL: `#room=sala`) |
| Touch | Like a map: one finger pans, two fingers pinch to zoom, twist to rotate (walls facing you are cut away as you turn). Phones start zoomed in on the house |
| Mouse | Left-drag orbits (and tilts), right-drag or Shift-drag pans, the wheel zooms |
| ⌖ (top right, once you've moved) | Back to the start view |

## Editing

**✎** opens a full-screen editor: storey tabs, a top-down plan (5 cm snapping, rooms that touch share a wall) and an inspector. Pinch or scroll to zoom, drag to pan, **Fit** to see everything again. On touch, tap something to select it, then drag it; with a mouse, drag directly. A room's corner dot resizes it. Rooms link to HA areas; lamps (`light`/`switch`) and ACs (`climate`, plus an optional temperature sensor) link to entities — each room offers its area's unplaced devices first. **Save** writes the plan into the card's own config in the dashboard; if the plan changed elsewhere since the editor opened, saving refuses instead of overwriting.

The room sheet follows the hide/order curation of your Areas dashboard (`areas_dashboard`, default `dashboard-areas`).

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `plan` | starter layout from your areas | The house — written by the editor |
| `status` | weather/people auto | Dock entities: `weather`, `people` (list), `solar`, `battery`, `load`, `appliances` (list of `{ name, icon, status, ends }` — an enum status sensor and a finish-time timestamp sensor; shows a live countdown while running, a green "done" chip at the end) |
| `language` | the viewer's HA language | `en` or `pt` for the card's own words |
| `car` | — | Chip over the plan's `car`: `battery` (%), `charging` (sensor or binary_sensor) |
| `sun` | `sun.sun` | Drives the light and sky (cloud cover from the `status.weather` entity greys it) |
| `idle_orbit` | `180` | Seconds without a touch before the house view slowly orbits (wall tablets); `false` turns it off |
| `ambient` | `true` | With the idle orbit, fade the controls and show a big clock, the date, the weather and who's home (a wall-tablet screensaver); `false` keeps just the orbit |
| `areas_dashboard` | `dashboard-areas` | Areas dashboard whose curation the room sheet uses |
| `height` | `calc(100vh - var(--header-height) - 16px)` | Card height |
| `dashboard` | from the URL | Dashboard url_path the editor saves into |

## Plan format

House Control's [floor plan](https://github.com/0xProbabillity/house-control/blob/main/docs/floor-plan.md), split into storeys:

```yaml
plan:
  name: Casa
  revision: 3
  wallHeight: 2.6
  levels:
    - id: res_de_chao
      name: Rés de Chão
      floor: res_de_chao          # HA floor
      rooms:
        - { id: sala, name: Sala, area: sala, rect: [0, 0, 6.4, 4.6], floor: oak }
        - { id: relva, name: Relva, area: relva, rect: [0, 4.6, 10, 6], outdoor: true, floor: grass }
      openings: [{ type: door, from: [6.4, 1.0], to: [6.4, 1.9] }]
      furniture: [{ type: sofa, pos: [3.9, 2.4], rot: -90, width: 2.5 }]
      lights: [{ entity: light.sala, room: sala, type: ceiling, pos: [2.9, 2.3] }]
      acs: [{ entity: climate.ac_sala, room: sala, wall: north, pos: [3, 0] }]
    - id: upper_floor
      name: Piso 1
      floor: upper_floor
      rooms: []
```

Outdoor rooms (`outdoor: true`) have no walls and take `grass`, `deck`, `paving`, `tile`, `stone`, `water` or `soil`. A storey's `elevation` defaults to stacking on the one below.

- **Rooms sharing an `area`** on a storey act as one room: no wall between them, one label, one room view. Use it for L-shapes and split zones.
- **Rooms** take `glow:` (a light): at night the floor takes that light's colour — e.g. a pool's water and its pool light.
- **Openings** take `sensor:` (a door/window `binary_sensor`): a red frame lights up on the model while it's open. **A `tv`** takes `entity:` (a `media_player`): its screen lights up while it's on.
- **Furniture** includes `stairs` (`width`, `length`, `rise`, `steps`, `rail`; climbs towards the piece's back; use the item's `y` to start a flight from a landing) and a `car` (a Tesla Model Y-ish crossover, `color`), for the driveway. Any piece takes `scale` (e.g. `0.55`).
- **Garden furniture**: `tree` (`height`, `kind`: `round` | `pine` | `olive` | `palm`, `seed`), `hedge` (`width`, `height`, `depth`), `bush` (`size`, `color` for flowers), `flowerbed` (`width`, `depth`), `bench` (`width`), `sunbed`, `parasol` (`size`, `color`), `grill` (`color`) and `outdoorSofa` (`width`, `color`). Trees, hedges, bushes and flowerbeds vary with their position unless given a `seed`.
- **`north`** — the plan direction `[x, z]` that faces real north (default `[0, -1]`, up the plan). The sun (from `sun.sun`, or the card's `sun:` option) lights the house from where it really is, with a matching sky; after dusk a soft moon takes over and lit lamps glow in the whole-house view.
- **`camera.azimuth`** sets the starting view (e.g. `-45` puts the house's +x side top-right).
- **`rot`** (degrees) turns a room about its rect's centre. A rotated room builds its own four walls and ignores openings. Where it overlaps axis-aligned rooms, its floor wins; put `type: open` openings on their edges to drop walls it replaces.

## Development

```bash
npm install
npm run dev     # http://localhost:5199/dev/ — needs dev/fixture.json + dev/dashboard-areas.json (a states snapshot)
npm run build   # dist/house-3d-card.js
```

Release: bump `version` in `package.json` and `VERSION` in `src/house-3d-card.js`, then `npm run build && gh release create vX.Y.Z dist/house-3d-card.js`.
