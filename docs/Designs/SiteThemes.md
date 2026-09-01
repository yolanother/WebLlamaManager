<!--
Copyright (c) Llama Manager contributors.
Use of this source code is governed by the LICENSE file in the repository root.

Design/reference doc for the dashboard's host-architecture "site theme" system:
the theme file contract, how themes are sourced from the private `site/` git
submodule at build time (and never committed to this public repo), the runtime
manifest/loader, and the Settings selector. Answers "how do dashboard site
themes work and how do I add one?".
-->

# Site Themes (host-architecture theming)

The dashboard UI (`ui/`) supports named **site themes** — platform-branded
appearances (e.g. `amd`, `nvidia`) that can be selected from **Settings → Site
Theme** for previewing/testing. A theme is applied as CSS custom-property
overrides plus an optional header-logo swap.

Theme **content is private** and is **never committed to this public repo**. The
build sources themes from the private `site/` git submodule *if it is checked
out*; with no submodule present the app builds and runs exactly as before (empty
manifest, default look, no console errors).

## Theme file contract

Each theme is a flat directory `site/themes/<id>/` containing:

- **`theme.css`** (required) — a rule block scoped to the theme selector that
  overrides the UI design tokens declared in `ui/src/index.css` (and any extra
  scoped rules):

  ```css
  :root[data-site-theme="amd"] {
    --bg-primary: #0b0b0d;
    --accent: #ed1c24;      /* AMD ember */
    --accent-hover: #ff4d4d;
    /* …override any token from ui/src/index.css :root … */
  }
  ```

  Because `:root[data-site-theme="<id>"]` is more specific than the base
  `:root`, its values win while the theme is active. The token families
  available to override are: core surfaces/text/status (`--bg-*`,
  `--text-*`, `--accent(-hover)`, `--success/warning/error/info`,
  `--border`), the soft/border tint variants of each status color, the
  neutral overlay/shade scales, surface variants (`--surface-well`,
  `--surface-code(-elevated)`, `--surface-input`), the categorical
  chart/series palette (`--series-1..7` and siblings), chart axis/grid
  chrome, and the resource-gauge ring colors (`--gauge-*`) — see
  [UiLookAndLayout.md](./UiLookAndLayout.md) for the full list.

  **Interaction with the Professional look.** When a user has selected the
  Professional Look (`ui/src/theme/professional.css`,
  `data-look="professional"`), Professional overrides the same base surface
  tokens (`--bg-primary` and friends) and the `.sidebar.sidebar-glass` rule
  with higher specificity than a site theme's own `:root[data-site-theme=
  "x"]` block, so a theme's surfaces and its own frosted sidebar styling are
  suppressed under Professional. The one token Professional never touches
  while a site theme is active is `--accent` — a theme's brand color (and
  the logo it drives) always carries through regardless of Look. See
  [UiLookAndLayout.md](./UiLookAndLayout.md#site-themes-vs-professional) for
  the specificity mechanics and the exact paired-selector pattern.

- **`theme.json`** (required) — metadata:

  ```json
  { "id": "amd", "label": "AMD Ryzen", "logo": "logo.svg" }
  ```

  `id` defaults to the directory name and `label` defaults to `id` when
  omitted; `logo` is optional.

- **`logo.svg` / `logo.png`** (optional) — replaces the header logo while the
  theme is active. Only honored when the file named by `theme.json.logo` exists.

The `default` id is reserved for the built-in appearance and is always offered
in the selector.

## Build sourcing from the submodule

Sourcing is handled by the Vite plugin `ui/vite-plugin-site-themes.js`:

- **`npm run build`** — the plugin scans `../site/themes` (repo-root
  `site/themes` when Vite runs from `ui/`). For every directory that has both
  `theme.json` and `theme.css` it copies the theme's files into
  `dist/themes/<id>/` and writes a manifest at `dist/themes/index.json`
  (`[{ "id", "label", "logo"? }, …]`). If the submodule is absent, it writes an
  **empty** manifest and copies nothing.
- **`vite dev`** — the same `/themes/index.json` and `/themes/<id>/<file>` paths
  are served on the fly from the submodule via dev middleware.

Theme content is **never imported into the JS bundle** — it is fetched at
runtime, so brand kits stay out of the public bundle and out of git.

## Runtime loader & selection

- `ui/src/theme/manifest.js` — pure, DOM-free logic (manifest parsing/
  normalization, selection resolution, URL helpers). Unit-tested under
  `node --test` (`ui/src/theme/manifest.test.js`; `npm test`).
- `ui/src/theme/siteTheme.js` — runtime controller. On startup
  (`initSiteTheme()` in `ui/src/main.jsx`) it fetches `themes/index.json`, sets
  `data-site-theme` on `<html>`, injects a `<link id="site-theme-css">` to the
  active theme's `theme.css`, swaps the header logo, and persists the selection
  in `localStorage["siteTheme"]`. A React external-store hook (`useSiteTheme`)
  drives the Settings selector and the sidebar logo.

Selection persists across reloads; an id no longer present in the manifest
falls back to `default`.

## Runtime surface

- Asset path `themes/` in `ui/dist` (manifest + per-theme files).
- `data-site-theme` attribute on `<html>`.
- `localStorage` key `siteTheme`.
- Settings entry **Site Theme** (hidden when the manifest is empty).

## Adding a theme

Author it in the **private `site` repo** under `themes/<id>/` (do **not** commit
theme files here). With the submodule checked out, rebuild the UI; the theme
appears in Settings automatically.

### Local testing without the private repo

Create a **throwaway** fixture (do not commit it):

```bash
mkdir -p site/themes/amd
printf '{ "id": "amd", "label": "AMD Ryzen" }\n' > site/themes/amd/theme.json
printf ':root[data-site-theme="amd"]{--accent:#ed1c24;--accent-hover:#ff4d4d;}\n' > site/themes/amd/theme.css
cd ui && npm run build   # dist/themes/index.json now lists "amd"
```

`site/` sits outside `ui/` and is not tracked here; remove the fixture when done.
