# OSM Lanes 3D

A browser-based 3D editor for OpenStreetMap lane tagging. Pick an area on the map, load
the roads, see lanes, markings, turn arrows and destination signs in 3D, edit them
lane by lane, and upload the result as an OSM changeset.

## What it shows

| OSM tagging | 3D rendering |
|---|---|
| `lanes`, `lanes:forward`, `lanes:backward`, `oneway` | One asphalt strip per lane, on the correct side for the driving side you choose |
| `lanes:both_ways=1` | Centre two-way turn lane with solid/dashed edges |
| `turn:lanes[:forward/:backward/:both_ways]` | Painted arrows near the end of each lane (`left`, `slight_right`, `through;right`, `reverse`, `merge_to_*`, …) |
| `change:lanes` | Lane divider style: dashed (both may change), solid (neither), or dashed + solid pair (one side only) |
| `overtaking[:forward/:backward]` | Centre line: dashed, double solid, or mixed |
| `destination:lanes`, `destination:ref:lanes` (or way-level `destination`/`destination:ref`) | Overhead gantry with a sign panel per lane |
| `width:lanes`, `placement` | Lane widths and the lateral position of the carriageway relative to the way |
| `surface` | Asphalt, concrete, paving, or a brown dirt/gravel road for unpaved surfaces |

## Workflow

1. **Choose the area.** Search for a place, zoom the map, and either press **Load** (loads
   the current view) or use **Draw area** / Shift+drag to draw a rectangle first.
   - *OSM API*: authoritative data, up to 0.25 square degrees.
   - *Overpass*: roads only, for larger areas. It can lag the main database by a few minutes.
2. **Select a road** on the map or in the 3D view. Clicking a lane in 3D focuses that lane in the editor.
3. **Edit** in the side panel: direction, lane counts, centre turn lane, and per lane the turn
   arrows, destinations, destination refs, lane-change rules and width. The **All tags**
   box is a raw `key=value` editor for anything else. Edits re-render the 3D view immediately;
   Ctrl+Z undoes them. Warnings flag mismatched lane counts and unknown values.
4. **Upload.** Review the tag diff, write a changeset comment and upload. You can also
   download the changes as an `.osc` file (to open in JOSM, for example).

Unsent edits are kept as a draft in your browser and restored when you load the same area
again, as long as nobody else has edited those ways in the meantime.

## Setting up uploading (OAuth 2)

Uploading needs an OAuth 2 application registered on the OSM server:

1. On openstreetmap.org (or the [dev server](https://master.apis.dev.openstreetmap.org) for
   testing) go to **My Settings → OAuth 2 applications → Register new application**.
2. Leave *Confidential application* **unchecked**, tick **Read user preferences** and
   **Modify the map**, and set the redirect URI to the `land.html` next to where the app
   is hosted. The app's **⚙ Settings** dialog shows the exact URI, e.g.
   `http://127.0.0.1:8080/land.html` for local development.
3. Paste the client ID into **⚙ Settings**, or bake it in at build time with
   `VITE_OSM_CLIENT_ID` / `VITE_OSM_DEV_CLIENT_ID`.

Try the **dev server** first: it's a separate test database, so mistakes there don't touch
the real map.

## Development

```sh
npm install
npm run dev        # http://127.0.0.1:8080 (OAuth needs 127.0.0.1, not localhost, or https)
npm test           # lane parsing/writing unit tests
npm run build      # static site in dist/
```

The build is a static site with relative paths, so `dist/` can be hosted anywhere. To deploy to
GitHub Pages on every push to `main`, copy `docs/github-pages-workflow.yml` to
`.github/workflows/pages.yml`, enable Pages with *Source: GitHub Actions* in the repository
settings, and add the Pages URL + `land.html` as a redirect URI on your OAuth app.

### Code map

- `src/lanes.ts`: parses lane tags into a per-lane model, writes them back, lays out lanes, validates
- `src/scene3d.ts`: Three.js scene: lane geometry, markings, arrows, gantries, picking, camera
- `src/textures.ts`: canvas-drawn turn arrows and sign panels
- `src/editor.ts`: lane editor side panel
- `src/map2d.ts`: Leaflet map, area selection, road overlay
- `src/osm.ts`: loading (API/Overpass), osmChange generation
- `src/upload.ts`: OAuth 2 login (osm-auth) and changeset upload

Map data © OpenStreetMap contributors, ODbL.
