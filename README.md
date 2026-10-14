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
| Storey chips | Pick the storey to show (starts on the ground floor; the top one shows the whole house) |
| **Aa** | Show / hide room names (off by default, remembered per device) |
| Tap a lamp in a room | Toggle it |
| Long-press a lamp / tap an AC | Home Assistant's device dialog |
| `← Casa`, Back | Back to the whole house (the room is in the URL: `#room=sala`) |
| Drag / pinch / scroll | Orbit all the way round / zoom — walls facing you are cut away as you turn |

## Editing

**✎** opens a full-screen editor: storey tabs, a top-down plan (5 cm snapping, rooms that touch share a wall) and an inspector. Pinch or scroll to zoom, drag to pan, **Fit** to see everything again. On touch, tap something to select it, then drag it; with a mouse, drag directly. A room's corner dot resizes it. Rooms link to HA areas; lamps (`light`/`switch`) and ACs (`climate`, plus an optional temperature sensor) link to entities — each room offers its area's unplaced devices first. **Save** writes the plan into the card's own config in the dashboard; if the plan changed elsewhere since the editor opened, saving refuses instead of overwriting.

The room sheet follows the hide/order curation of your Areas dashboard (`areas_dashboard`, default `dashboard-areas`).

## Options

| Key | Default | Meaning |
| --- | --- | --- |
| `plan` | starter layout from your areas | The house — written by the editor |
| `status` | weather/people auto | Dock entities: `weather`, `people` (list), `solar`, `battery`, `load` |
| `car` | — | Chip over the plan's `car`: `battery` (%), `charging` (sensor or binary_sensor) |
| `sun` | `sun.sun` | Drives the light and sky |
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
- **Furniture** includes a `car` (a Tesla Model Y-ish crossover, `color`), for the driveway. Any piece takes `scale` (e.g. `0.55`).
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
