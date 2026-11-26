// Side panel: structured per-lane editor plus a raw tag editor.

import {
  CHANGE_VALUES, TURN_VALUES, emptyLane, parseRoad, validate, writeRoad,
  type Dir, type Lane, type LaneKey, type RoadModel,
} from './lanes';
import { diffTags, type OsmWay, type ServerConfig, type Tags } from './osm';

const TURN_GLYPH: Record<string, string> = {
  sharp_left: '↙', left: '←', slight_left: '↖', through: '↑', slight_right: '↗', right: '→',
  sharp_right: '↘', reverse: '↶', merge_to_left: '⇠', merge_to_right: '⇢', none: '∅',
};

export type { LaneRef } from './scene3d';
import type { LaneRef } from './scene3d';

function h(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function tagsToText(t: Tags): string {
  return Object.keys(t).sort().map((k) => `${k}=${t[k]}`).join('\n');
}

export function textToTags(s: string): Tags {
  const out: Tags = {};
  for (const raw of s.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf('=');
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
}

export class LaneEditor {
  private way: OsmWay | null = null;
  private model: RoadModel | null = null;
  private focus: LaneRef | null = null;

  /** Called with the full new tag set when the user edits. */
  onChange: (wayId: number, tags: Tags) => void = () => {};
  /** Called when the user clicks a lane column. */
  onFocusLane: (ref: LaneRef | null) => void = () => {};
  onRevert: (wayId: number) => void = () => {};
  server: ServerConfig | null = null;

  constructor(private root: HTMLElement) {
    root.addEventListener('click', (e) => this.onClick(e));
    root.addEventListener('change', (e) => this.onInput(e));
  }

  show(way: OsmWay | null, focus: LaneRef | null = null) {
    this.way = way;
    this.focus = focus;
    this.render();
  }

  /** Re-render, keeping keyboard focus on the same field (edits commit on blur). */
  private render() {
    const active = document.activeElement as HTMLElement | null;
    let restore: string | null = null;
    if (active && this.root.contains(active)) {
      const card = active.closest<HTMLElement>('.lane');
      const sel = active.dataset.k ? `[data-k="${active.dataset.k}"]` : active.dataset.act ? `[data-act="${active.dataset.act}"]${active.dataset.v ? `[data-v="${active.dataset.v}"]` : ''}` : null;
      if (sel) restore = card ? `.lane[data-dir="${card.dataset.dir}"][data-i="${card.dataset.i}"] ${sel}` : sel;
    }
    const scroll = this.root.scrollTop;
    this.renderInner();
    this.root.scrollTop = scroll;
    if (restore) this.root.querySelector<HTMLElement>(restore)?.focus({ preventScroll: true });
  }

  private renderInner() {
    const w = this.way;
    if (!w) {
      this.root.innerHTML = `<div class="empty">
        <h2>No road selected</h2>
        <p>Pick an area on the map, press <b>Load</b>, then click a road on the map or in the 3D view.</p>
        <ul class="legend">
          <li><span style="background:#1e88e5"></span>has per-lane tags</li>
          <li><span style="background:#7e57c2"></span>lane count only</li>
          <li><span style="background:#9e9e9e"></span>no lane tags</li>
          <li><span style="background:#ff6d00"></span>edited (not uploaded)</li>
        </ul>
      </div>`;
      return;
    }
    const m = (this.model = parseRoad(w.tags));
    const isOneway = m.oneway !== 'no';
    const name = w.tags.name ?? w.tags.ref ?? '(unnamed)';
    const web = this.server?.webUrl ?? 'https://www.openstreetmap.org';
    const changed = diffTags(w.origTags, w.tags).length;
    const warnings = validate(w.tags);

    const counter = (label: string, act: string, n: number) => `
      <div class="counter"><span>${label}</span>
        <button data-act="${act}-" title="Remove a lane">−</button><b>${n}</b><button data-act="${act}+" title="Add a lane">+</button>
      </div>`;

    const dirSection = (dir: Dir, lanes: Lane[], title: string) => `
      <section class="dir">
        <h3>${title}</h3>
        <div class="lanes" data-dir="${dir}">
          ${lanes.map((l, i) => this.laneCard(dir, i, l)).join('')}
        </div>
      </section>`;

    this.root.innerHTML = `
      <header class="way-head">
        <div>
          <h2>${h(name)}</h2>
          <div class="sub">${h(w.tags.highway ?? '')}${w.tags.ref && w.tags.name ? ' · ' + h(w.tags.ref) : ''} ·
            <a href="${web}/way/${w.id}" target="_blank" rel="noopener">way ${w.id}</a> v${w.version}</div>
        </div>
        ${changed ? `<button class="ghost" data-act="revert" title="Discard edits to this way">Revert (${changed})</button>` : ''}
      </header>

      <section class="road">
        <div class="seg" role="group" aria-label="Direction">
          <button data-act="oneway:no" class="${m.oneway === 'no' ? 'on' : ''}">Two-way</button>
          <button data-act="oneway:yes" class="${m.oneway === 'yes' ? 'on' : ''}">One-way →</button>
          <button data-act="oneway:-1" class="${m.oneway === '-1' ? 'on' : ''}">One-way ← (−1)</button>
        </div>
        <div class="counters">
          ${isOneway
            ? counter('Lanes', 'fw', m.forward.length)
            : counter('Forward', 'fw', m.forward.length) + counter('Backward', 'bw', m.backward.length) +
              `<label class="check"><input type="checkbox" data-act="both" ${m.bothWays ? 'checked' : ''}> Centre turn lane</label>`}
        </div>
        ${m.implied ? '<p class="hint">No lane tags yet — editing will add them.</p>' : ''}
      </section>

      ${dirSection('forward', m.forward, isOneway ? (m.oneway === '-1' ? 'Lanes (travel ← against way direction)' : 'Lanes (travel → with way direction)') : 'Forward → (with way direction)')}
      ${m.bothWays ? `<section class="dir"><h3>Centre two-way lane</h3><div class="lanes" data-dir="both_ways">${this.laneCard('both_ways', 0, m.bothWays)}</div></section>` : ''}
      ${isOneway ? '' : dirSection('backward', m.backward, 'Backward ← (against way direction)')}

      ${warnings.length ? `<section class="warnings">${warnings.map((x) => `<div class="${x.level}">${h(x.text)}</div>`).join('')}</section>` : ''}

      <details class="raw" ${changed ? 'open' : ''}>
        <summary>All tags</summary>
        <textarea spellcheck="false" rows="12">${h(tagsToText(w.tags))}</textarea>
        <div class="row"><button data-act="raw-apply">Apply tag text</button></div>
        ${changed ? `<div class="diff">${diffTags(w.origTags, w.tags).map((d) => `
          <div class="${d.before === undefined ? 'add' : d.after === undefined ? 'del' : 'mod'}">
            <code>${h(d.key)}</code>
            ${d.before !== undefined ? `<s>${h(d.before)}</s>` : ''}${d.after !== undefined ? ` → <b>${h(d.after)}</b>` : ' (removed)'}
          </div>`).join('')}</div>` : ''}
      </details>
    `;
  }

  private laneCard(dir: Dir | 'both_ways', i: number, l: Lane): string {
    const turns = new Set(l.turn.split(';').filter(Boolean));
    const focused = this.focus && this.focus.dir === dir && this.focus.index === i;
    const removable = dir !== 'both_ways';
    return `
      <div class="lane ${focused ? 'focused' : ''}" data-dir="${dir}" data-i="${i}">
        <div class="lane-h" data-act="focus">
          <span>Lane ${i + 1}</span>
          ${removable ? `<span class="tools">
            <button data-act="ins-left" title="Insert a lane to the left">+◂</button>
            <button data-act="ins-right" title="Insert a lane to the right">▸+</button>
            <button data-act="del" title="Remove this lane">✕</button></span>` : ''}
        </div>
        <div class="turns">
          ${TURN_VALUES.map((t) => `<button class="chip ${turns.has(t) ? 'on' : ''}" data-act="turn" data-v="${t}" title="${t}">${TURN_GLYPH[t]}</button>`).join('')}
        </div>
        <label>Destination <small>(one per line)</small>
          <textarea data-k="destination" rows="2">${h(l.destination.split(';').join('\n'))}</textarea></label>
        <label>Destination ref <small>(e.g. A 9;E 51)</small>
          <input data-k="destination:ref" value="${h(l['destination:ref'])}"></label>
        <div class="two">
          <label>Change
            <select data-k="change">${CHANGE_VALUES.map((c) => `<option value="${c}" ${l.change === c ? 'selected' : ''}>${c || '—'}</option>`).join('')}
            ${l.change && !(CHANGE_VALUES as readonly string[]).includes(l.change) ? `<option selected>${h(l.change)}</option>` : ''}</select></label>
          <label>Width (m)
            <input data-k="width" inputmode="decimal" value="${h(l.width)}" placeholder="auto"></label>
        </div>
      </div>`;
  }

  private laneAt(dir: string, i: number): Lane | null {
    const m = this.model!;
    if (dir === 'both_ways') return m.bothWays;
    return (dir === 'forward' ? m.forward : m.backward)[i] ?? null;
  }

  private commit() {
    if (!this.way || !this.model) return;
    this.onChange(this.way.id, writeRoad(this.way.tags, this.model));
  }

  private onClick(e: Event) {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn || !this.way || !this.model) return;
    const act = btn.dataset.act!;
    const m = this.model;
    const card = btn.closest<HTMLElement>('.lane');
    const dir = card?.dataset.dir as Dir | 'both_ways' | undefined;
    const i = Number(card?.dataset.i ?? 0);
    const list = dir === 'backward' ? m.backward : m.forward;

    switch (act) {
      case 'focus':
        if ((e.target as HTMLElement).closest('button')) return;
        this.focus = dir ? { dir, index: i } : null;
        this.root.querySelectorAll('.lane.focused').forEach((x) => x.classList.remove('focused'));
        card?.classList.add('focused');
        this.onFocusLane(this.focus);
        return;
      case 'revert':
        this.onRevert(this.way.id);
        return;
      case 'oneway:no':
      case 'oneway:yes':
      case 'oneway:-1': {
        const v = act.split(':')[1] as RoadModel['oneway'];
        if (v === m.oneway) return;
        if (v === 'no' && m.oneway !== 'no' && !m.backward.length) m.backward = [emptyLane()];
        m.oneway = v;
        break;
      }
      case 'fw+': m.forward.push(emptyLane()); break;
      case 'fw-': if (m.forward.length > 1) m.forward.pop(); else return; break;
      case 'bw+': m.backward.push(emptyLane()); break;
      case 'bw-': if (m.backward.length > 0) m.backward.pop(); else return; break;
      case 'both': m.bothWays = m.bothWays ? null : { ...emptyLane(), turn: 'left' }; break;
      case 'ins-left': list.splice(i, 0, emptyLane()); break;
      case 'ins-right': list.splice(i + 1, 0, emptyLane()); break;
      case 'del':
        if (dir === 'forward' && list.length <= 1) return;
        list.splice(i, 1);
        break;
      case 'turn': {
        const lane = dir && this.laneAt(dir, i);
        if (!lane) return;
        const v = btn.dataset.v!;
        const cur = new Set(lane.turn.split(';').filter(Boolean));
        if (cur.has(v)) cur.delete(v);
        else {
          if (v === 'none') cur.clear();
          else cur.delete('none');
          cur.add(v);
        }
        lane.turn = TURN_VALUES.filter((t) => cur.has(t)).join(';');
        this.focus = { dir: dir!, index: i };
        break;
      }
      case 'raw-apply': {
        const ta = this.root.querySelector<HTMLTextAreaElement>('.raw textarea');
        if (ta) this.onChange(this.way.id, textToTags(ta.value));
        return;
      }
      default:
        return;
    }
    this.commit();
  }

  private onInput(e: Event) {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (el.matches('[data-act="both"]')) return; // handled by click
    const k = el.dataset.k as LaneKey | undefined;
    const card = el.closest<HTMLElement>('.lane');
    if (!k || !card || !this.model) return;
    const lane = this.laneAt(card.dataset.dir!, Number(card.dataset.i));
    if (!lane) return;
    let v = el.value;
    if (k === 'destination') v = v.split('\n').map((s) => s.trim()).filter(Boolean).join(';');
    lane[k] = v.trim();
    this.focus = { dir: card.dataset.dir as LaneRef['dir'], index: Number(card.dataset.i) };
    // `change` fires before focus moves on; wait so render() can restore focus to the new field.
    setTimeout(() => this.commit(), 0);
  }
}
