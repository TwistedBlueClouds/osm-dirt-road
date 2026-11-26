// Leaflet map: choose the area to load, show loaded roads, click to select.

import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { BBox, OsmData } from './osm';
import { isModified } from './osm';

export class AreaMap {
  readonly map: L.Map;
  private roadLayer = L.layerGroup();
  private lines = new Map<number, L.Polyline>();
  private areaRect: L.Rectangle | null = null;
  private loadedRect: L.Rectangle | null = null;
  private drawing = false;
  private selectedId: number | null = null;
  private data: OsmData | null = null;
  onSelect: (wayId: number) => void = () => {};
  onAreaChange: (b: BBox | null) => void = () => {};

  constructor(el: HTMLElement) {
    this.map = L.map(el, { zoomControl: true, preferCanvas: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    this.roadLayer.addTo(this.map);
    this.restoreView();
    this.map.on('moveend', () => this.saveView());
    this.installDraw();
  }

  private restoreView() {
    const m = /map=(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(location.hash);
    if (m) this.map.setView([+m[2], +m[3]], +m[1]);
    else this.map.setView([52.5096, 13.3759], 17); // Berlin, Potsdamer Platz
  }

  private saveView() {
    const c = this.map.getCenter();
    const z = this.map.getZoom();
    history.replaceState(null, '', `#map=${z}/${c.lat.toFixed(5)}/${c.lng.toFixed(5)}`);
  }

  /** Shift-drag (or "Draw area" mode) draws the load rectangle. */
  private installDraw() {
    let start: L.LatLng | null = null;
    const container = this.map.getContainer();
    this.map.on('mousedown', (e: L.LeafletMouseEvent) => {
      if (!this.drawing && !e.originalEvent.shiftKey) return;
      start = e.latlng;
      this.map.dragging.disable();
      this.map.boxZoom.disable();
    });
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      if (!start) return;
      const b = L.latLngBounds(start, e.latlng);
      if (!this.areaRect) {
        this.areaRect = L.rectangle(b, { color: '#ff6d00', weight: 2, fillOpacity: 0.06, dashArray: '6 4', interactive: false }).addTo(this.map);
      } else this.areaRect.setBounds(b);
    });
    this.map.on('mouseup', () => {
      if (!start) return;
      start = null;
      this.map.dragging.enable();
      this.map.boxZoom.enable();
      this.setDrawing(false);
      this.onAreaChange(this.getArea());
    });
    container.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.setDrawing(false);
    });
  }

  setDrawing(on: boolean) {
    this.drawing = on;
    this.map.getContainer().classList.toggle('drawing', on);
  }

  clearArea() {
    this.areaRect?.remove();
    this.areaRect = null;
    this.onAreaChange(null);
  }

  /** Drawn rectangle if any, otherwise the current view. */
  getArea(): BBox | null {
    if (!this.areaRect) return null;
    const b = this.areaRect.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  getView(): BBox {
    const b = this.map.getBounds();
    return { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() };
  }

  setLoaded(b: BBox, data: OsmData) {
    this.data = data;
    this.loadedRect?.remove();
    this.loadedRect = L.rectangle([[b.south, b.west], [b.north, b.east]], {
      color: '#1565c0', weight: 1, fill: false, dashArray: '2 4', interactive: false,
    }).addTo(this.map);
    this.areaRect?.remove();
    this.areaRect = null;
    this.roadLayer.clearLayers();
    this.lines.clear();
    for (const w of data.ways.values()) {
      const ll = w.nodes.map((id) => {
        const n = data.nodes.get(id)!;
        return [n.lat, n.lon] as [number, number];
      });
      const pl = L.polyline(ll, { weight: 5, opacity: 0.85 });
      pl.on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        this.onSelect(w.id);
      });
      const name = w.tags.name ?? w.tags.ref ?? w.tags.highway;
      pl.bindTooltip(`${name} · way ${w.id}`, { sticky: true });
      this.lines.set(w.id, pl);
      pl.addTo(this.roadLayer);
      this.restyle(w.id);
    }
  }

  restyle(id: number) {
    const pl = this.lines.get(id);
    const w = this.data?.ways.get(id);
    if (!pl || !w) return;
    const hasLanes = Object.keys(w.tags).some((k) => k.includes(':lanes'));
    let color = hasLanes ? '#1e88e5' : w.tags.lanes ? '#7e57c2' : '#9e9e9e';
    if (isModified(w)) color = '#ff6d00';
    const sel = id === this.selectedId;
    pl.setStyle({ color: sel ? '#00e5ff' : color, weight: sel ? 9 : 5 });
    if (sel) pl.bringToFront();
  }

  select(id: number | null, pan = false) {
    const prev = this.selectedId;
    this.selectedId = id;
    if (prev != null) this.restyle(prev);
    if (id != null) {
      this.restyle(id);
      const pl = this.lines.get(id);
      if (pan && pl && !this.map.getBounds().contains(pl.getBounds())) this.map.fitBounds(pl.getBounds(), { maxZoom: 18 });
    }
  }
}
