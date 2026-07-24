/*
 * Copyright (c) Llama Manager contributors.
 * Use of this source code is governed by the LICENSE file in the repository root.
 *
 * Vite plugin that sources selectable "site themes" from the private `site/`
 * git submodule at build time WITHOUT committing any theme content to this
 * public repo. At build it discovers each `../site/themes/<id>/` directory
 * (requiring `theme.json` + `theme.css`), copies its files into the build
 * output under `dist/themes/<id>/`, and writes a `dist/themes/index.json`
 * manifest of `{id,label,logo?}` entries — an EMPTY manifest when the submodule
 * is absent, so the app builds and runs unchanged with zero themes present.
 * During `vite dev` it serves the same `/themes/*` paths directly from the
 * submodule via middleware. Theme content is never imported into the JS bundle;
 * it is loaded at runtime by ui/src/theme/siteTheme.js.
 */

import {
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from 'fs';
import { join, resolve } from 'path';

/** Output/URL subdirectory under which themes are emitted and served. */
const THEMES_SUBDIR = 'themes';

/**
 * Map a filename to a reasonable Content-Type for the dev middleware.
 * @param {string} file - Filename or path.
 * @returns {string} MIME type.
 */
function contentTypeFor(file) {
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Discover valid themes under the submodule themes root.
 *
 * A directory is a theme when it contains both `theme.json` and `theme.css`.
 * The manifest `id`/`label`/`logo` come from `theme.json`, defaulting `id` to
 * the directory name and `label` to the `id`; `logo` is kept only when the file
 * actually exists in the theme directory.
 *
 * @param {string} themesRoot - Absolute path to `site/themes`.
 * @returns {{manifest: {id:string,label:string,logo?:string}[], dirs: Record<string,string>}}
 *   The normalized manifest and a map of theme id -> absolute source directory.
 */
function discoverThemes(themesRoot) {
  const manifest = [];
  const dirs = {};
  if (!existsSync(themesRoot)) return { manifest, dirs };

  let names;
  try {
    names = readdirSync(themesRoot).sort();
  } catch {
    return { manifest, dirs };
  }

  for (const name of names) {
    const dir = join(themesRoot, name);
    let st;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const jsonPath = join(dir, 'theme.json');
    const cssPath = join(dir, 'theme.css');
    if (!existsSync(jsonPath) || !existsSync(cssPath)) continue;

    let meta;
    try {
      meta = JSON.parse(readFileSync(jsonPath, 'utf8'));
    } catch {
      continue;
    }

    const id =
      meta && typeof meta.id === 'string' && meta.id.trim()
        ? meta.id.trim()
        : name;
    if (dirs[id]) continue; // first-wins on duplicate ids
    const label =
      meta && typeof meta.label === 'string' && meta.label.trim()
        ? meta.label.trim()
        : id;

    const entry = { id, label };
    if (meta && typeof meta.logo === 'string' && meta.logo.trim()) {
      const logo = meta.logo.trim();
      if (existsSync(join(dir, logo))) entry.logo = logo;
    }

    manifest.push(entry);
    dirs[id] = dir;
  }

  return { manifest, dirs };
}

/**
 * Copy the (flat) files of a theme source directory into a destination dir.
 * Subdirectories are skipped — themes are intentionally flat.
 * @param {string} srcDir - Absolute source theme directory.
 * @param {string} destDir - Absolute destination directory (created if needed).
 */
function copyThemeDir(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    let st;
    try {
      st = statSync(src);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    copyFileSync(src, join(destDir, name));
  }
}

/**
 * Create the site-themes Vite plugin.
 *
 * @param {object} [options] - Plugin options.
 * @param {string} [options.themesRoot] - Override for the submodule themes root
 *   (defaults to `<cwd>/../site/themes`, i.e. repo-root `site/themes` when Vite
 *   runs from `ui/`).
 * @returns {import('vite').Plugin} The configured plugin.
 */
export default function siteThemesPlugin(options = {}) {
  const themesRoot = resolve(
    options.themesRoot || join(process.cwd(), '..', 'site', 'themes')
  );

  return {
    name: 'site-themes',

    /**
     * Dev: serve `/themes/index.json` and `/themes/<id>/<file>` straight from
     * the submodule so theme preview works with `vite dev`.
     */
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url && req.url.split('?')[0];
        if (!url || !url.startsWith(`/${THEMES_SUBDIR}/`)) return next();

        const { manifest, dirs } = discoverThemes(themesRoot);

        if (url === `/${THEMES_SUBDIR}/index.json`) {
          res.setHeader('Content-Type', contentTypeFor('index.json'));
          res.end(JSON.stringify(manifest));
          return;
        }

        const rest = url.slice(`/${THEMES_SUBDIR}/`.length);
        const slash = rest.indexOf('/');
        if (slash === -1) return next();
        const id = decodeURIComponent(rest.slice(0, slash));
        const file = decodeURIComponent(rest.slice(slash + 1));
        const dir = dirs[id];
        // Reject path traversal and unknown themes.
        if (!dir || !file || file.includes('..') || file.includes('/')) {
          return next();
        }
        const filePath = join(dir, file);
        if (!existsSync(filePath)) return next();

        res.setHeader('Content-Type', contentTypeFor(file));
        res.end(readFileSync(filePath));
      });
    },

    /**
     * Build: copy discovered themes into the output dir and emit the manifest.
     * Runs after the bundle is written (so `emptyOutDir` has already cleared
     * the directory) — an empty manifest is written when no submodule exists.
     */
    writeBundle(outputOptions) {
      const outDir = outputOptions.dir || resolve(process.cwd(), 'dist');
      const destRoot = join(outDir, THEMES_SUBDIR);
      const { manifest, dirs } = discoverThemes(themesRoot);

      mkdirSync(destRoot, { recursive: true });
      for (const entry of manifest) {
        copyThemeDir(dirs[entry.id], join(destRoot, entry.id));
      }
      writeFileSync(
        join(destRoot, 'index.json'),
        JSON.stringify(manifest, null, 2)
      );
    },
  };
}
