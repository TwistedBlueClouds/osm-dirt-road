# Vendored from osm-simple3d-editor

`building-geometry.ts`, `roof-gables.ts` and `heights.ts` are copied from
[osm-simple3d-editor](https://github.com/FelisPimeja/osm-simple3d-editor) (commit 55dde63),
© 2026 Aleksandr Petrov (FelisPimeja), ISC license (see `LICENSE`).

Local changes:
- import paths adjusted to this folder;
- `skeleton.ts` is a stub: the straight-skeleton (CGAL/WebAssembly) solver is not bundled,
  so pitched roofs on outlines that need it fall back to flat roofs;
- `i18n.ts` is a pass-through for the UI strings in `shapeOf`.
