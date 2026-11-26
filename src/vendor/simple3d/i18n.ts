// Pass-through replacement for osm-simple3d-editor's translation helper.
export function tr(s: string, params?: Record<string, string | number>): string {
  return params ? s.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? '')) : s;
}
