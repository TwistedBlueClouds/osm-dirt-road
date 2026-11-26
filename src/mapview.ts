// The single map: MapLibre with a raster basemap (aerial imagery or OSM), tilt/rotate,
// area selection, and a coloured road overlay for when you're zoomed out.

import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, Map as MlMap, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { BBox, OsmData } from './osm';
import { isModified } from './osm';

export type Basemap = 'imagery' | 'osm';

const ESRI_ATTRIBUTION =
  'Imagery: Esri, Maxar, Earthstar Geographics, GIS User Community · ' +
  '<a href="https://wiki.openstreetmap.org/wiki/Esri" target="_blank" rel="noopener">Terms</a>';
const OSM_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

if (import.meta.env.PROD) maplibregl.setWorkerUrl(new URL('maplibre/maplibre-gl-worker.mjs', document.baseURI).href);

function style(basemap: Basemap): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: 'raster', tileSize: 256, maxzoom: 19, attribution: OSM_ATTRIBUTION,
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      },
      imagery: {
        type: 'raster', tileSize: 256, maxzoom: 19, attribution: ESRI_ATTRIBUTION + ' · Data ' + OSM_ATTRIBUTION,
        tiles: [
          'https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false',
          'https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?blankTile=false',
        ],
      },
      roads: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      area: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': '#8f9a84' } },
      { id: 'osm', type: 'raster', source: 'osm', layout: { visibility: basemap === 'osm' ? 'visible' : 'none' } },
      { id: 'imagery', type: 'raster', source: 'imagery', layout: { visibility: basemap === 'imagery' ? 'visible' : 'none' } },
      {
        id: 'loaded', type: 'line', source: 'area', filter: ['==', ['get', 'kind'], 'loaded'],
        paint: { 'line-color': '#4fc3f7', 'line-width': 2, 'line-dasharray': [2, 2] },
      },
      {
        id: 'draw-fill', type: 'fill', source: 'area', filter: ['==', ['get', 'kind'], 'draw'],
        paint: { 'fill-color': '#ff6d00', 'fill-opacity': 0.12 },
      },
      {
        id: 'draw', type: 'line', source: 'area', filter: ['==', ['get', 'kind'], 'draw'],
        paint: { 'line-color': '#ff6d00', 'line-width': 2.5 },
      },
      {
        // Tag-status overview; fades out as the 3D lanes become readable.
        id: 'roads', type: 'line', source: 'roads',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 12, 2, 16, 6],
          'line-opacity': ['interpolate', ['linear'], ['zoom'], 15.5, 0.9, 17, 0],
        },
      },
    ],
    sky: {
      'sky-color': '#9cc4e4', 'horizon-color': '#dfeaf2', 'fog-color': '#dfeaf2',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2,
    },
  };
}

function ring(b: BBox): number[][] {
  return [[b.west, b.south], [b.east, b.south], [b.east, b.north], [b.west, b.north], [b.west, b.south]];
}

export class MapView {
  readonly map: MlMap;
  private data: OsmData | null = null;
  private loaded: BBox | null = null;
  private area: BBox | null = null;
  private drawing = false;
  private selectedId: number | null = null;
  readonly ready: Promise<void>;
  /** Click that hit a road in the zoomed-out overlay. */
  onOverlayClick: (wayId: number) => void = () => {};
  onAreaChange: (b: BBox | null) => void = () => {};

  constructor(el: HTMLElement, basemap: Basemap) {
    this.map = new maplibregl.Map({
      container: el,
      style: style(basemap),
      center: [13.3759, 52.5096], // Berlin, Potsdamer Platz
      zoom: 17,
      pitch: 55,
      maxPitch: 80,
      maxZoom: 22,
      hash: 'map',
      boxZoom: false, // Shift+drag draws the load area instead
      attributionControl: { compact: true },
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-left');
    this.map.addControl(new maplibregl.ScaleControl({}), 'bottom-left');
    this.ready = new Promise((res) => this.map.once('load', () => res()));
    this.installDraw();
    this.map.on('click', 'roads', (e) => {
      if (this.map.getZoom() >= 16.5) return; // 3D picking takes over
      const id = e.features?.[0]?.properties?.id;
      if (id != null) this.onOverlayClick(Number(id));
    });
  }

  setBasemap(b: Basemap) {
    this.map.setLayoutProperty('osm', 'visibility', b === 'osm' ? 'visible' : 'none');
    this.map.setLayoutProperty('imagery', 'visibility', b === 'imagery' ? 'visible' : 'none');
  }

  // ---- area selection -----------------------------------------------------

  private installDraw() {
    let start: maplibregl.LngLat | null = null;
    const m = this.map;
    m.on('mousedown', (e) => {
      if (!this.drawing && !e.originalEvent.shiftKey) return;
      e.preventDefault();
      start = e.lngLat;
      m.dragPan.disable();
    });
    m.on('mousemove', (e) => {
      if (!start) return;
      this.area = {
        south: Math.min(start.lat, e.lngLat.lat), north: Math.max(start.lat, e.lngLat.lat),
        west: Math.min(start.lng, e.lngLat.lng), east: Math.max(start.lng, e.lngLat.lng),
      };
      this.refreshArea();
    });
    const end = () => {
      if (!start) return;
      start = null;
      m.dragPan.enable();
      this.setDrawing(false);
      this.onAreaChange(this.area);
    };
    m.on('mouseup', end);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.drawing) this.setDrawing(false);
    });
  }

  setDrawing(on: boolean) {
    this.drawing = on;
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
  }

  /** The drawn rectangle, if any. */
  getArea(): BBox | null {
    return this.area;
  }

  /** Bounding box of what's on screen (can be large when tilted toward the horizon). */
  getView(): BBox {
    const b = this.map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  private refreshArea() {
    const f = (kind: string, b: BBox) => ({
      type: 'Feature' as const, properties: { kind },
      geometry: { type: 'Polygon' as const, coordinates: [ring(b)] },
    });
    const features = [];
    if (this.loaded) features.push(f('loaded', this.loaded));
    if (this.area) features.push(f('draw', this.area));
    (this.map.getSource('area') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  // ---- loaded roads overlay -----------------------------------------------

  setLoaded(b: BBox | null, data: OsmData | null) {
    this.data = data;
    this.loaded = b;
    this.area = null;
    this.refreshArea();
    this.refreshRoads();
  }

  /** Call after a way's tags change. */
  restyle(_id?: number) {
    this.refreshRoads();
  }

  select(id: number | null) {
    this.selectedId = id;
    this.refreshRoads();
  }

  private refreshRoads() {
    const d = this.data;
    const features = [];
    if (d) {
      for (const w of d.ways.values()) {
        const hasLanes = Object.keys(w.tags).some((k) => k.includes(':lanes'));
        let color = hasLanes ? '#42a5f5' : w.tags.lanes ? '#b39ddb' : '#e0e0e0';
        if (isModified(w)) color = '#ff6d00';
        if (w.id === this.selectedId) color = '#00e5ff';
        features.push({
          type: 'Feature' as const,
          properties: { id: w.id, color },
          geometry: {
            type: 'LineString' as const,
            coordinates: w.nodes.map((id) => {
              const n = d.nodes.get(id)!;
              return [n.lon, n.lat];
            }),
          },
        });
      }
    }
    (this.map.getSource('roads') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** Fly to look along a way. */
  focus(frame: { center: { lng: number; lat: number }; bearing: number; length: number }) {
    const zoom = Math.max(17.2, Math.min(19.6, 19.6 - Math.log2(Math.max(frame.length, 40) / 40)));
    this.map.flyTo({ center: frame.center, bearing: frame.bearing, pitch: 62, zoom, duration: 900 });
  }

  fitLoaded() {
    if (!this.loaded) return;
    const b = this.loaded;
    this.map.fitBounds([[b.west, b.south], [b.east, b.north]], { pitch: 45, bearing: 0, duration: 900, padding: 30 });
  }
}
