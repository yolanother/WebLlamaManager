<!--
Copyright (c) Llama Manager contributors.
Use of this source code is governed by the LICENSE file in the repository root.

Design/reference doc for the dashboard's two independent appearance
preferences — Look (classic glass vs. flat "professional") and Layout
(dashboard-first vs. chat-first) — covering their storage/DOM/URL-override
mechanics, the token families and structural rules Professional overrides,
the chat-first shell's component structure and routes, and how site themes
interact with each. Answers "what do Look and Layout do, and how do I add a
token or a structural rule to Professional?".
-->

# UI Look and Chat-first Layout

The dashboard UI (`ui/`) has two independent, per-device appearance
preferences, each persisted to `localStorage` and applied as an attribute on
`<html>`:

| Preference | Module | Storage key | Values | Default | Root attribute |
|---|---|---|---|---|---|
| Look | `ui/src/theme/look.js` | `uiLook` | `classic`, `professional` | `professional` | `data-look` |
| Layout | `ui/src/theme/layout.js` | `uiLayout` | `dashboard`, `chat-first` | `dashboard` | `data-layout` |

Both are independent of each other and of the existing `colorScheme`
(dark/light/system) and `siteTheme` preferences documented in
[SiteThemes.md](./SiteThemes.md) — any Look can pair with any Layout, color
scheme, or site theme.

## Preference mechanics

`ui/src/theme/look.js` and `ui/src/theme/layout.js` are pure, DOM-free
modules: each exports its storage key, its default, and a
`normalize(value)` function that returns the default for anything not in its
value set. Each has a matching `node --test` file (`look.test.js`,
`layout.test.js`).

`ui/src/theme/uiPrefs.js` owns the DOM/storage side for both, built from one
shared helper, `createAttributePreference({ storageKey, attribute, normalize,
defaultValue })`, which returns `{ get, set, use, init }`:

- `init()` reads the persisted value (or default), applies it to `<html>`,
  and broadcasts it. Called once at startup for each preference, from
  `initUiPrefs()`.
- `set(value)` normalizes, persists to `localStorage`, applies the
  `data-look`/`data-layout` attribute, and notifies subscribers.
- `use()` is a `useSyncExternalStore`-based React hook returning the live
  value (`useLook()` / `useLayout()`).
- `get()` is a synchronous imperative read, for non-component code.

`initUiPrefs()` is called from `main.jsx` before the first render, next to
`initSiteTheme()`, so both attributes are on `<html>` before first paint —
no flash of the wrong Look or Layout.

**URL override.** After `init()`, `initUiPrefs()` checks the page URL for
`?look=` and/or `?layout=`. Any value present is normalized, applied, and
persisted (exactly like a Settings change), then just those two parameters
are stripped from the URL via `history.replaceState` (other query
parameters are preserved). This gives kiosk provisioning, docs links, and
headless screenshot checks a way to select a preference without visiting
Settings.

## Look: token families

`ui/src/index.css` declares the base semantic design-token contract that
every other stylesheet and JSX chart consumes instead of raw color literals.
Its families:

- **Core surfaces/text/status** — `--bg-primary/secondary/tertiary`,
  `--text-primary/secondary/tertiary(-alt)`, `--accent(-hover/-light)`,
  `--success/warning/error/info`, `--border`.
- **Status soft (tint) and border variants** — `--success-soft(-2/-3/-4)`,
  `--success-border`, and the matching `--warning-*`/`--error-*`/`--info-*`
  sets, plus `--accent-soft(-2/-3/-4)`/`--accent-border`.
- **Neutral overlays and shades** — `--overlay-1..4`, `--overlay-3pct/5pct`
  (white), `--shade-1..4`, `--shade-16/18/42/50` (black).
- **Surfaces** — `--surface-well`, `--surface-code(-elevated)`,
  `--surface-input`.
- **Categorical chart/series palette** — `--series-1..7` plus their
  `-soft`/`-deep`/`-light`/`-alt`/`-alt2` siblings, and `--pill-text`.
- **Chart axis/grid chrome** — `--chart-axis-line`, `--chart-axis-text`,
  `--chart-value-text`, `--chart-app-usage`.
- **Resource-gauge ring colors** — `--gauge-track`, `--gauge-cpu`,
  `--gauge-memory`, `--gauge-gtt`, `--gauge-gpu`, `--gauge-context`
  (aliased to the matching status token by default, so Classic renders
  identically to before the alias existed; overriding these names alone
  retints gauges independently of buttons/badges).

`ui/src/theme/glass.css` layers the Classic look's skeuomorphic-glass
tokens and primitives on top: `--glass-bg(-elevated)(-opaque)`,
`--glass-border`, `--glass-highlight`, `--glass-blur`, `--glass-saturate`,
`--glass-sheen`, `--shadow-raised/floating/pressed`, `--radius-sm/md/lg/xl`,
`--control-height`, and the reusable `.glass-panel`, `.glass-panel--floating`,
`.glass-btn`, `.glass-input`, `.glass-chip` classes. It also carries the
`[data-theme="light"]` overrides for the core tokens above, the
`[data-effects="simple"]` (opaque, no blur) tier, and the
`prefers-reduced-motion`/`prefers-reduced-transparency` fallbacks. See
[glass-ui-and-multimodal-chat.md](../features/glass-ui-and-multimodal-chat.md)
for the Classic design system's history.

## Look: Professional

`ui/src/theme/professional.css` is the Professional look: a flat,
desaturated override activated by `:root[data-look="professional"]`,
imported in `main.jsx` after `glass.css`. It has two parts.

### Token overrides

A dark base block re-declares the token families above with flat neutral
surfaces (`#121316`/`#191a1e`/`#202227`), hairline borders
(`rgba(255,255,255,0.08)`), and:

- Glass collapses to opaque fills: `--glass-bg` → `--glass-bg-opaque`,
  `--glass-blur: 0px`, `--glass-saturate: 100%`, `--glass-sheen: none`,
  `--glass-highlight: transparent`.
- Shadows reduce to a 1px hairline plus a soft 2px shade
  (`--shadow-raised/floating/pressed` all collapse to the same value).
- No ambient wallpaper or radial glow: `--ambient-image: none`,
  `--ambient-accent/success/info: transparent`.
- Status colors (`--success/warning/error/info`) are desaturated; their
  `-soft`/`-border` variants are recomputed with `color-mix()` (10%/25% of
  the base color) rather than reusing Classic's per-variant literals.
- The series/chart palette becomes a muted set of the same hues; the many
  `-deep`/`-light`/`-alt`/`-alt2` siblings collapse onto one muted base
  per series rather than each keeping a bespoke tint (`ponytail:` flat
  mapping in the source — split per-token only if a chart is found to need
  distinct shades under Professional).
- `--gauge-track` becomes neutral (`--overlay-4` / `rgba(15,23,42,0.12)` in
  light); every gauge fill (`--gauge-cpu/memory/gtt/gpu/context`) becomes
  `--accent` (see structural rule 1 for how severity still overrides this).

`--accent`/`--accent-hover` are **only** overridden in a separate
`:not([data-site-theme])` block — see "Site themes" below.

A `[data-theme="light"]`-paired block supplies the light-scheme surface,
text, border, and status tokens.

### Structural rules (7)

Some Classic chrome (borders, tinted backgrounds, glows) isn't expressible
by retargeting tokens alone, since the shared component/utility classes set
those properties directly. Professional carries exactly seven bounded,
class-scoped overrides for these, each under `:root[data-look="professional"]`:

1. **Gauges** — `.progress-ring-bg` stroke uses `--gauge-track`;
   `.progress-ring-fill` (excluding multi-segment `.progress-ring-segment`
   rings, whose colors are a semantic split, not a severity signal) uses
   `--accent`, switching to `--warning`/`--error` only via the ring's own
   `data-severity="warning"|"critical"` attribute. Thermal readouts
   (`.stats-header-temp`) are untouched — they're inline-colored text, not a
   ring.
2. **Status and model cards** — `.stat-card.success/warning/error` and
   `.model-card.active` drop their tinted background/colored full border for
   a neutral border plus a small synthesized `::before` colored dot.
   `.server-status-strip` (which already renders a real `.status-strip-dot`)
   only loses its colored border and the dot's glow. `.badge`/`.mode-badge`
   variants drop their tinted background and `currentColor` border, keeping
   only colored text.
3. **Outline buttons** — `.btn-secondary`/`.btn-warning`/`.btn-danger`
   become transparent with colored text and a 25%-tinted border, filling
   solid only on hover. `.btn-primary` is untouched (already token-driven).
4. **Page header / tab strip** — `.page-header` (incl. `.glass-panel` /
   `.glass-panel--floating` variants, and the Dashboard hero) and every
   tab-strip-only panel (`.settings-tabs`, `.logs-tabs`, `.api-tabs`) drop
   their panel background/border/shadow/blur for a single
   `border-bottom: 1px solid var(--border)`.
5. **Sidebar** — `.sidebar.sidebar-glass` becomes flat `--bg-secondary`
   with a right hairline border, no sheen/shadow/blur; `.nav-item.active`
   becomes an `--overlay-2` background with `--accent` text/icon, no glow.
6. **Stats header** — `.stats-header` drops its panel styling for a
   borderless strip with a hairline `border-bottom`.
7. **Floating quick-query button** — `.query-fab` becomes neutral
   `--bg-tertiary` with `--border` instead of solid `--accent`.

### Site themes vs. Professional

Every Professional token block that sets `--bg-primary` (i.e. every base
surface block, dark and light) is **paired with the matching
`[data-site-theme]` selector**:

```css
:root[data-look="professional"],
:root[data-look="professional"][data-site-theme] { … }
```

This gives the pairing specificity `(0,3,0)`, which outranks an active site
theme's own `:root[data-site-theme="x"]` rule at `(0,2,0)`/`(0,1,1)` (see
[SiteThemes.md](./SiteThemes.md)) — so Professional's flat surfaces still
win over a site theme's own surface tokens. Structural rule 5 (sidebar) is
paired the same way, so Professional's flat sidebar beats a site theme's own
frosted `.sidebar` rule too.

**`--accent` is the one exception.** Professional never sets `--accent` (or
`--accent-hover`) while a site theme is active — that override lives in a
separate `:root[data-look="professional"]:not([data-site-theme])` block, so
with no site theme selected Professional gets its own calmer indigo
(`#6b70e0`), but with a site theme active, that theme's brand accent (and
the logo it drives elsewhere) carries through unchanged.

### Guards

- `ui/src/theme/tokens.test.js` fails the suite if a raw color literal
  (`#hex`, `rgb()`, `rgba()`, `hsl()`) appears in any of the six
  token-bearing stylesheets (`index.css`, `glass.css`, `professional.css`,
  `App.css`, `styles/pages.css`, `styles/chat.css`, `styles/sidebar.css`)
  outside a `:root`/`[data-theme=]`/`[data-effects=]`/`[data-look=]`
  selector block, and if a quoted hex literal or numeric `rgba()` literal
  appears in any JSX file outside its (currently empty) allowlist. This is
  the mechanical half of "Classic stays pixel-identical".
- `ui/src/theme/professional.test.js` is a structural guard specific to
  `professional.css`: every rule stays scoped under
  `:root[data-look="professional"]`; every `--bg-primary`-setting block is
  paired with `[data-site-theme]`; `--accent` is only ever set inside a
  `:not([data-site-theme])` block; `--ambient-image: none` and
  `--glass-blur: 0px` are present; all seven structural-rule selectors
  exist; and a `[data-theme="light"]`-paired block overrides the light
  surface/text/status tokens.

### Adding a token or a structural rule

- **New token used by more than one component**: add it to `ui/src/index.css`
  (Classic value) and, if Professional should retint it, add the same name
  to the appropriate `professional.css` block (base dark block, the
  `:not([data-site-theme])` accent block, or the light block) — pairing with
  `[data-site-theme]` only if it also sets `--bg-primary` in that same rule,
  per `professional.test.js`'s contract.
- **New structural override** (a component whose Classic chrome can't be
  expressed by retargeting a token): add an eighth bounded, class-scoped
  rule under `:root[data-look="professional"]` in `professional.css`,
  document it in the numbered list above and in the design spec, and extend
  `professional.test.js`'s "declares the … structural rule selectors" test
  with its selector.

## Layout: dashboard vs. chat-first

`ui/src/App.jsx`'s `AppLayout` reads `useLayout()` and branches before
routing:

- `/kiosk` is checked **first**, independent of Layout — it always renders a
  bare, full-screen `<Dashboard kiosk />` (no sidebar, no chat, no nav
  header), regardless of the Layout preference. Kiosk *does* still follow
  Look, since `data-look` is a global `<html>` attribute applied by
  `initUiPrefs()` before the route ever renders — see "Known leftovers"
  below for what this means in practice for the shipped kiosk appliance.
- `layout === 'chat-first'` renders `ChatFirstShell`.
- Otherwise (`'dashboard'`, the default) renders the original
  `Sidebar` + `StatsHeader` + routed-page shell, where `/` and `/dashboard`
  both route to `Dashboard`.

### Chat-first shell structure

`ui/src/components/ChatFirstShell.jsx` renders:

- `ChatSidebar` — the single navigation column (see below).
- A top bar (`chat-first-topbar`): hamburger button (opens the sidebar as an
  off-canvas drawer below 1024px), `StatusPill`, and — only on the `/` chat
  route, only when a conversation is active — that conversation's title and
  message count.
- The routed page area, with the same reconnect banner as the dashboard
  shell.
- A floating `QueryPanel`, same as the dashboard shell.

**Routes** (`ChatFirstShell`'s `<Routes>`): `/` renders `ChatPage` (chat is
the home route in chat-first); `/dashboard` renders `Dashboard`; `/chat` also
renders `ChatPage`; every other admin route (`/presets`, `/models`,
`/download`, `/logs`, `/logs/:tab`, `/queue`, `/processes`, `/settings`,
`/docs`, `/api-docs`) is unchanged from the dashboard shell. In the
dashboard layout, `/` and `/dashboard` both render `Dashboard` — so `/` is
always a route to *something* reachable, but which page depends on Layout:
Chat in chat-first, Dashboard otherwise.

`ui/src/components/ChatSidebar.jsx` renders, top to bottom:

- A header with the site-theme-aware logo (`useSiteThemeLogo`), the
  "Llama Manager" title, and a collapse button.
- A "New chat" button.
- `ConversationList` (shared with the dashboard layout's chat page — see
  below), showing every conversation from the shared `conversationStore`.
- A collapsible **Manage** group (open state persisted at localStorage key
  `chatFirstManageOpen`, default open) listing every admin page via
  `ui/src/components/manageLinks.js`'s `MANAGE_LINKS` array — a pure,
  DOM-free, ordered list (`dashboard`, `models`, `presets`, `download`,
  `logs`, `queue`, `processes`, `docs`, `api-docs`, plus the external
  `llama.cpp UI` link) kept separate from the JSX so it's covered by
  `node --test` without a JSX transform.
- A footer with a Settings link and a live health indicator.

Below 1024px width the sidebar is an off-canvas drawer (`is-open` class plus
a scrim), mirroring `chat/ConversationSidebar.jsx`'s existing pattern; on
mobile, selecting a conversation or a Manage link auto-closes it.

`ui/src/components/StatusPill.jsx` renders the top bar's health dot, coarse
state, and active-model label (delegated to the pure
`ui/src/components/statusPillLabel.js`), and toggles the existing
`StatsHeader` open as a popover strip beneath it on click (closed by Escape
or an outside click).

### Shared conversation store

`ui/src/components/chat/conversationStore.js` is a `useSyncExternalStore`
external store that owns the conversation list and active id, persisted
under the **same** localStorage keys the dashboard layout's `Chat.jsx`
previously kept in local `useState` (`chat_conversations`,
`chat_active_conversation`). This is what lets both the dashboard layout's
chat page and the chat-first shell's `ChatSidebar` show and mutate the same
conversations. It guarantees at least one conversation always exists, keeps
the active id valid, and reports localStorage persistence failures through
`subscribeErrors` rather than throwing. `ui/src/components/chat/
ConversationList.jsx` (the date-grouped list with inline rename/delete) is
reused as-is by both `ChatSidebar` and the dashboard layout's
`ConversationSidebar`.

## Settings

`ui/src/pages/Settings.jsx`'s `AppearanceSection` renders four segmented
controls, in this order: **Look** (Classic/Professional) → **Color scheme**
(Dark/Light/System) → **Effects** (Auto/Glass/Simple) → **Layout**
(Dashboard/Chat-first). The Effects control is disabled (`disabled=
{isProfessional}`) whenever Look is Professional, since Professional's flat
token overrides make the Glass/Simple effects tier moot; its hint text
switches to "Not used by the Professional look." and the "Re-run performance
check" button is disabled too.

## Known leftovers

- Four `[data-theme="light"] .selector { color: #hex; }` element rules in
  `ui/src/styles/pages.css` (around lines 309–325, the logs page's error/
  system/stream-badge colors) still carry raw color literals rather than
  tokens. They're outside the migration's token-block allowlist in
  `tokens.test.js` but were left as-is rather than introducing new token
  names for four narrowly-scoped rules.
- The kiosk appliance's `/kiosk` route ignores the Layout preference (see
  above) but does follow the Look preference, whose shipped default is now
  `professional`. A kiosk install that wants to keep the original glass look
  needs `?look=classic` pinned into the URL it launches Chromium/cage with
  (see `scripts/llama-kiosk-launch.sh` / `scripts/lib/kiosk-common.sh`),
  otherwise it renders in Professional by default like every other fresh
  install.
