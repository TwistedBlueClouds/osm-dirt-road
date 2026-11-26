# OSM Lanes 3D

A browser-based 3D editor for OpenStreetMap lane tagging. Pick an area on a tiltable map,
load the roads, see lanes, markings, turn arrows, junctions and destination signs in 3D
over aerial imagery, edit them lane by lane, and upload the result as an OSM changeset.

## What it shows

| OSM tagging | 3D rendering |
|---|---|
| `lanes`, `lanes:forward`, `lanes:backward`, `oneway` | One surface strip per lane, on the correct side for the driving side you choose |
| `lanes:both_ways=1` | Centre two-way turn lane with solid/dashed edges |
| `turn:lanes[:forward/:backward/:both_ways]` | Painted arrows near the end of each lane (`left`, `slight_right`, `through;right`, `reverse`, `merge_to_*`, …) |
| `change:lanes` | Lane divider style: dashed (both may change), solid (neither), or dashed + solid pair (one side only) |
| `overtaking[:forward/:backward]` | Centre line: dashed, double solid, or mixed |
| `destination:lanes`, `destination:ref:lanes` (or way-level `destination`/`destination:ref`) | Overhead gantry with a sign panel per lane |
| `bus:lanes`, `psv:lanes`, `taxi:lanes`, `hov:lanes`, `bicycle:lanes`, `access:lanes`… | Lane types: tinted bus/taxi/cycle lanes with BUS / TAXI lettering or a cycle symbol, darkened no-access lanes |
| `maxspeed:lanes` | Speed painted in the lane |
| `width:lanes`, `placement` | Lane widths and the lateral position of the carriageway relative to the way |
| `sidewalk`, `cycleway:left/right/both`, `parking:left/right/both`, `shoulder` | Roadside strips: raised pavement, cycle lane or track, parking bays, hard shoulder |
| `highway=crossing` (+ `crossing`, `crossing:markings`), `highway=traffic_signals`, `highway=stop` / `give_way`, `traffic_calming` on nodes | Zebra or line crossings, stop and give-way lines, signal heads, signs, speed humps |
| `bridge`, `layer`, `tunnel` | Raised bridges with decks, parapets and piers, approach ramps that climb to them, faded tunnels |
| `type=connectivity` relations, or `turn:lanes` and junction shape where none is mapped | Lane connections: arrows from a lane to the lanes it leads into, dashed guide lines for turns through junctions |
| `surface` | Asphalt, concrete, paving, or a brown dirt/gravel road for unpaved surfaces |
| `building`, `building:part`, `height`, `building:levels`, `roof:shape`, colours; `natural=tree`, tree rows | Surrounding buildings (Simple 3D Buildings) and trees, for orientation |

Where three or more roads meet, each road is cut back to where its edges meet its neighbours'
and the junction is filled with a surface with rounded corners.

## Workflow

1. **Choose the area.** Search for a place, move the map, and either press **Load** (loads
   the current view) or use **Draw area** / Shift+drag to draw a rectangle first.
   - *OSM API*: authoritative data, up to 0.25 square degrees.
   - *Overpass*: for larger areas. It can lag the main database by a few minutes.
2. **Look around.** Drag to pan, right-drag (or Ctrl+drag) to tilt and rotate. Switch the
   background between aerial imagery and the OSM map, lower the **Surface** slider to compare
   the drawn markings with the imagery underneath, and hide buildings if they are in the way.
3. **Select a road** by clicking a lane (or, zoomed out, the coloured road line).
4. **Edit** in the side panel:
   - direction, lane counts, centre turn lane;
   - per lane: type, speed limit, turn arrows, destinations, destination refs, lane-change
     rules and width;
   - roadside: pavement, cycleway, parking and hard shoulder on each side;
   - lane connections: press **⇢** on a lane, then click each lane it leads into at the
     junction (click again to remove, Esc to finish). This writes a `type=connectivity`
     relation;
   - **All tags** is a raw `key=value` editor for anything else.

   Edits re-render immediately; Ctrl+Z undoes them. Warnings flag mismatched lane counts and
   unknown values. Adding or removing a lane keeps every `*:lanes` tag on the way aligned.
5. **Upload.** Review the changes, write a changeset comment and upload. You can also
   download the changes as an `.osc` file (to open in JOSM, for example).

Unsent tag edits are kept as a draft in your browser and restored when you load the same area
again, as long as nobody else has edited those ways in the meantime. Lane-connection edits
are not part of the draft yet.

### Limits worth knowing

- The view draws what the tags say; it does not check them against the imagery.
- Heights are estimated from `layer` (6 m per level), not surveyed. Edit `bridge`/`layer`
  and reload the area to see new heights.
- Pitched roofs on complex outlines are drawn flat (see `src/vendor/simple3d/README.md`).
- Islands, hatched areas and other painted areas mapped as polygons are not drawn.
- Lane connections are only inferred where roads end at a junction node.

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
npm test           # lane model and junction unit tests
npm run build      # static site in dist/
```

The build is a static site with relative paths, so `dist/` can be hosted anywhere. To deploy to
GitHub Pages on every push to `main`, copy `docs/github-pages-workflow.yml` to
`.github/workflows/pages.yml`, enable Pages with *Source: GitHub Actions* in the repository
settings, and add the Pages URL + `land.html` as a redirect URI on your OAuth app.

### Code map

- `src/lanes.ts`: per-lane model (parse, write, lane types, roadside, layout, validation)
- `src/lanelayer.ts`: MapLibre custom layer (Three.js): lanes, markings, arrows, gantries, street features, picking
- `src/junctions.ts`: junction cut-backs and surfaces, lane connections
- `src/elevation.ts`: bridge and ramp heights
- `src/context.ts`: surrounding buildings and trees
- `src/mapview.ts`: the map, backgrounds, area selection, zoomed-out road overlay
- `src/textures.ts`: canvas-drawn arrows, lettering, signs and signals
- `src/editor.ts`: lane editor side panel
- `src/osm.ts`: loading (API/Overpass), osmChange generation
- `src/upload.ts`: OAuth 2 login (osm-auth) and changeset upload
- `src/vendor/simple3d/`: building and roof geometry from osm-simple3d-editor

## Credits

- [osm-simple3d-editor](https://github.com/FelisPimeja/osm-simple3d-editor) by Aleksandr Petrov
  (ISC): building and roof geometry is vendored from it, and the Three.js-in-MapLibre layer
  setup and the bridge height approach follow its design.
- [Lane Studio](https://github.com/MarcelMarzec/LaneStudio) by the Lane Studio contributors
  (ISC, a fork of iD): the lane-type rules follow its model, and its lane types, roadside,
  street features, junctions and connectivity tools were the model for the same features here.
- Aerial imagery: Esri World Imagery. Map tiles and data © OpenStreetMap contributors.

Map data © OpenStreetMap contributors, ODbL.
