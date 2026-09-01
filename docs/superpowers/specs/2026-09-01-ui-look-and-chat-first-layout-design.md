<!--
Copyright (c) Llama Manager contributors.
Use of this source code is governed by the LICENSE file in the repository root.

Design spec for two new dashboard appearance preferences: a "Look" (Classic
glass vs. a desaturated Professional look) and a "Layout" (Dashboard vs. a
ChatGPT-style Chat-first shell). Covers the full raw-color-to-token migration
that makes the Professional look a pure token layer, the preference modules,
the chat-first shell and shared conversation store, Settings changes, testing,
and the workstream breakdown. Answers "why does the UI have Look and Layout
settings, and how are they built?".
-->

# UI Look and Chat-first Layout

**Date:** 2026-09-01 · **Author:** Arthur · **Status:** approved design, not yet implemented

## Goal

The current dashboard reads as gaudy: an ambient wallpaper, three tinted
radial glows, per-card glass sheen, six colored ring gauges in the header and
six more on the dashboard, saturated indigo and amber button fills, and
colored full borders on status and model cards. Compared with ChatGPT and
Claude, which use one flat neutral surface and reserve saturated color for a
single primary action and status dots, ours has three competing light sources
and too many nested containers. Chat is also a dashboard page: it sits under
the stats header, beside the admin sidebar, with its own inner conversation
rail, giving three navigation columns.

This spec adds two user preferences:

- **Look** — `classic` (today's glass UI, unchanged) or `professional` (flat,
  desaturated, ChatGPT/Claude-like). Default: `professional`.
- **Layout** — `dashboard` (today's shell) or `chat-first` (a single
  conversation sidebar with a Manage group; chat is the home route).
  Default: `dashboard`.

Platform site themes (AMD, NVIDIA) keep supplying their accent color and logo
under both looks. Under Professional their wallpaper and frosted-glass sidebar
are suppressed.

## Non-goals

- Changing the kiosk route's structure. Kiosk follows Look (it shares the
  box's localStorage) but ignores Layout.
- Redesigning individual admin pages beyond what the token layer and the
  bounded structural rules below produce.
- Adding an external font. The appliance is offline; the system font stack
  stays.
- Server-side persistence of preferences. All four appearance preferences are
  per-device localStorage, as today.

## Preferences

Two pure modules and one small DOM store, following the existing
`ui/src/theme/colorScheme.js` pattern.

| Preference | Module | Storage key | Values | Default | Root attribute |
|---|---|---|---|---|---|
| Look | `ui/src/theme/look.js` | `uiLook` | `classic`, `professional` | `professional` | `data-look` |
| Layout | `ui/src/theme/layout.js` | `uiLayout` | `dashboard`, `chat-first` | `dashboard` | `data-layout` |

Each pure module exports the storage key, the default, and `normalizeX(value)`
which returns the default for anything unrecognised. Each has a `node --test`
file.

`ui/src/theme/uiPrefs.js` owns DOM and storage for both, using one helper
`createAttributePreference({ storageKey, attribute, normalize, defaultValue })`
that returns `{ get, set, use }`. `use` is a `useSyncExternalStore` hook.
`initUiPrefs()` is called from `main.jsx` before render, next to
`initSiteTheme()`, so the attributes are on `<html>` before first paint.

**URL override.** On init, if the page URL carries `?look=` or `?layout=`,
the value is normalised, persisted, and applied, then the parameters are
removed with `history.replaceState`. This gives kiosk provisioning, docs
links, and headless screenshot checks a way to select a preference without a
UI.

## Token migration (Classic stays pixel-identical)

Every raw color literal in `ui/src/index.css`, `ui/src/App.css`,
`ui/src/styles/pages.css`, `ui/src/styles/chat.css`,
`ui/src/styles/sidebar.css`, and `ui/src/theme/glass.css` moves to a custom
property whose value is exactly the literal it replaces. Inline color
literals in JSX, chiefly the chart color map in `ui/src/components/util.jsx`,
become `var(--…)` strings (SVG `fill`/`stroke` accept them).

Tokens are declared in two places only: `index.css` `:root` for base
semantics and `glass.css` for glass, depth, and the light-scheme overrides.
New token families, named to match what they replace:

- **Status:** `--info` (already exists in App.css, moves to index.css),
  `--success-soft`, `--warning-soft`, `--error-soft`, `--info-soft`,
  `--accent-soft` (the 6–20 % tints), and `--success-border`,
  `--warning-border`, `--error-border`, `--info-border`, `--accent-border`.
- **Neutral overlays:** `--overlay-1` … `--overlay-4` (white at 2/4/6/10 %),
  `--shade-1` … `--shade-4` (black at 20/30/40/60 %).
- **Text:** `--text-tertiary` (the `#6b7280` / `#9ca3af` greys),
  `--text-inverse`.
- **Surfaces:** `--surface-well` (`#2a2f3a`), `--surface-code` (`#0d1117`,
  `#161b22`), `--surface-input`.
- **Series:** `--series-1` … `--series-8` for the categorical palette (cyan,
  violet, blue, orange, pink, emerald, lime, amber) used by charts, badges,
  and the remote-host bar palette. Secondary shades that only appear once
  (e.g. `#4c1d95`, `#5b21b6`) become `--series-N-deep`.
- **Gauge:** `--gauge-track`, `--gauge-cpu`, `--gauge-memory`, `--gauge-gtt`,
  `--gauge-gpu`, `--gauge-context` — one per ring, so Professional can
  neutralise them without touching markup.

Where a literal only appears inside an existing light-scheme override block,
the token gets its light value in the `[data-theme="light"]` block in
`glass.css`; the block in `pages.css`/`chat.css` is deleted once empty.

**Guard.** `ui/src/theme/tokens.test.js` reads the six stylesheets and fails
if any `#hex`, `rgb(`, `rgba(`, `hsl(` literal appears outside a `:root`,
`[data-theme=…]`, `[data-effects=…]`, or `[data-look=…]` declaration block.
A second assertion greps `ui/src/**/*.jsx` for quoted hex literals and fails
on any hit outside a small allow-list (currently empty).

**Verification.** Headless Chrome screenshots of `/`, `/chat`, `/models`,
`/settings` at 1440×900 with `?look=classic` before and after the migration,
reviewed side by side. Live gauges make a strict pixel diff noisy, so the
check is visual, and the token test is the mechanical guard.

## Professional look

`ui/src/theme/professional.css`, imported in `main.jsx` after `glass.css`.
Everything is scoped to the look attribute. Because site-theme stylesheets
are injected after the bundle and use `:root[data-site-theme="x"]`
(specificity 0,1,1), every Professional rule is written with two selectors so
it wins whether or not a site theme is active:

```css
:root[data-look="professional"],
:root[data-look="professional"][data-site-theme] { … }
```

Rules that a site theme scopes to an element (the AMD frosted `.sidebar`) get
the matching `:root[data-look="professional"][data-site-theme] .sidebar`
override.

**Token values (dark).** Surfaces are neutral near-black in three steps:
`--bg-primary #121316`, `--bg-secondary #191a1e` (sidebar), `--bg-tertiary
#202227` (inputs, cards). `--border` and `--glass-border` are white at 8 %.
Text: `--text-primary #ececec`, `--text-secondary #9a9ca3`,
`--text-tertiary #6f727a`. Glass collapses to flat: `--glass-bg` and
`--glass-bg-elevated` equal their opaque counterparts, `--glass-blur 0px`,
`--glass-saturate 100%`, `--glass-sheen none`, `--glass-highlight
transparent`, all `--shadow-*` reduce to a 1 px hairline plus a 2 px 20 %
shade. `--ambient-image none` and the three `--ambient-*` glows transparent.
`--radius-lg 12px`, `--radius-xl 16px`. Status colors desaturate to
`--success #3fb950`, `--warning #d29922`, `--error #f0616d`, `--info #58a6ff`
with soft tints at 10 % and borders at 25 %. Series colors take a muted set
of the same hues. Gauge tokens all become `--gauge-track` white at 10 % with
the fill `--accent`; the CPU and memory temperature readouts keep their
threshold color.

**Accent.** Professional never sets `--accent`, so AMD red and NVIDIA green
carry through. When no site theme is active
(`:root[data-look="professional"]:not([data-site-theme])`) the default accent
becomes a calmer indigo, `--accent #6b70e0`, `--accent-hover #8085ea`.

**Light scheme.** A matching `[data-theme="light"]` block under the look:
`#f7f7f8` / `#ffffff` / `#f0f0f2` surfaces, `#1f1f22` text, 10 % black
borders, and the desaturated status set at their light-safe values.

**Structural rules.** These cannot be expressed as token values and are the
complete list; anything else stays token-driven:

1. **Gauges** (`ProgressRing` in `util.jsx` and the CSS around
   `.stats-header-item`, `.resource-card`): track uses `--gauge-track`, fill
   uses `--accent`, and the fill switches to `--warning` or `--error` only
   when the existing severity helper returns those levels.
2. **Status and model cards** (`.status-card`, `.server-card`, `.model-card`
   states, the "Loaded" badge): tinted background and colored full border
   removed; neutral `--border` plus a colored 8 px dot and colored badge text.
3. **Buttons:** only `.btn-primary` stays solid accent. `.btn-secondary`,
   `.btn-warning`, `.btn-danger` become outline buttons with colored text and
   a 25 % colored border, filling only on hover.
4. **Page header and tab strip** (`.page-header`, `.settings-tabs`,
   `.glass-panel` wrappers that only hold a title or tabs): panel background,
   border, and shadow removed; a single hairline `border-bottom` remains.
5. **Sidebar:** flat `--bg-secondary`, no sheen or drop shadow; active item is
   `--overlay-2` background with `--accent` text and icon, no glow.
6. **Stats header:** panel background and shadow removed; it becomes a
   borderless strip with a hairline `border-bottom`.
7. **Floating quick-query button:** neutral `--bg-tertiary` with `--border`
   instead of solid accent.

**Effects control.** Under Professional the Auto/Glass/Simple control is
rendered disabled with the hint "Not used by the Professional look." The
stored effects preference is untouched so switching back to Classic restores
it.

## Chat-first layout

### Conversation store

`ui/src/components/chat/conversationStore.js` takes over the state that
`pages/Chat.jsx` currently holds in `useState`: the conversation list and
the active id, with the same localStorage keys (`chat_conversations`,
`chat_active_conversation`) so existing data needs no migration. It exposes
`useConversations()` returning `{ conversations, activeId, active }` and
imperative `createConversation`, `deleteConversation`, `renameConversation`,
`updateConversation(id, updates)`, `selectConversation`,
`importConversations`. The existing `loadConversations` normalisation and
`makeConversation` move here. Persistence errors surface through a
`subscribeErrors` callback that the Chat page wires to its existing
`pageError` state.

Pure pieces (`normalizeConversations`, the reducers behind each action, and
`dateGroup`) live in the same file behind DOM-free exports and are covered by
`conversationStore.test.js`.

### Shared list

The date-grouped list with rename and delete is extracted from
`ConversationSidebar.jsx` into `ConversationList.jsx`. `ConversationSidebar`
keeps its frame (workspace header, New conversation button, Import/Export
footer, responsive dismissal) and renders the list. The chat-first sidebar
renders the same list.

### Shell

`ui/src/components/ChatFirstShell.jsx` is chosen by `App.jsx` when the layout
preference is `chat-first`; `AppLayout` is otherwise unchanged. Kiosk is
checked first, as today.

Layout: `[ChatSidebar][top bar + routed page]`.

**ChatSidebar** (`ui/src/components/ChatSidebar.jsx`, styles in
`ui/src/styles/chat-sidebar.css`):

1. Header: site-theme logo, "Llama Manager", collapse button.
2. "New chat" button.
3. `ConversationList` (grows, scrolls).
4. "Manage" group, collapsible, collapsed state remembered in localStorage
   `chatFirstManageOpen`: Dashboard, Models, Presets, Download, Logs, Queue,
   Processes, Docs, API Docs, llama.cpp UI (external). Uses the same
   `NavLink` + icon set as `Sidebar.jsx`.
5. Footer: Settings link and the health status indicator.

Below 1024 px the sidebar is an off-canvas drawer opened by a hamburger in
the top bar and closed by backdrop click, Escape, or navigation.

**Top bar** (`ui/src/components/StatusPill.jsx`): a pill with the health dot,
"Running / Starting / Stopped", and the active model or "Router (Multi)". A
click toggles the existing `StatsHeader` rendered as a popover strip under
the bar; Escape and outside click close it. On the chat route the bar also
shows the conversation title and message count that the Chat page's stage
header shows today.

**Routes.** `/dashboard` is added to both layouts as the Dashboard page. In
chat-first, `/` renders `ChatPage`; in the dashboard layout `/` stays
Dashboard. All other routes are shared. `Sidebar.jsx` keeps linking to `/`.

**Chat page in chat-first.** `ChatPage` receives `embedded` and, when true,
does not render `ConversationSidebar`, the hamburger, or the New-conversation
icon button (the shell provides all three). The message column is centred at
`max-width: 48rem` with the composer pinned to the bottom, matching the
ChatGPT/Claude reference. `QueryPanel` is not rendered on `/` in chat-first;
it stays on admin pages.

## Settings

`AppearanceSection` in `pages/Settings.jsx` gains two segmented controls
using the existing `scheme-segmented` / `scheme-option` markup:

1. **Look** — Classic / Professional. Hint: "Professional flattens surfaces
   and reserves color for actions and status. Site themes still supply the
   accent."
2. Color scheme (unchanged).
3. Effects (unchanged; disabled under Professional, see above).
4. **Layout** — Dashboard / Chat-first. Hint: "Chat-first makes chat the home
   page with a single conversation sidebar. Admin pages live under Manage."
5. Site theme (unchanged).

Both apply instantly and persist, like the existing controls.

## Testing

- `look.test.js`, `layout.test.js`: normalisation and defaults.
- `tokens.test.js`: no raw color literals outside token blocks (see above).
- `conversationStore.test.js`: normalisation, every reducer, `dateGroup`.
- Gates in every worktree before landing: `npm test` and `npm run build`
  run from `ui/` (the same vite build `install.sh` performs on deploy).
- Visual: headless Chrome screenshots of the four pages in each of the four
  Look × Layout combinations under the default and AMD site themes, attached
  to the orch task for review. The Classic before/after pair is the
  regression check for the migration.

## Documentation

- New `docs/Designs/UiLookAndLayout.md`: the preference contract, the token
  families, the Professional rule list, the chat-first shell, and how a site
  theme should behave under each look.
- `docs/Designs/SiteThemes.md`: token contract section updated to list the
  new families and the Professional override precedence.
- `orch docs sync` after both.

## Workstreams

| # | Workstream | Files (primary) | Depends on |
|---|---|---|---|
| 1 | Token migration + guard test | the six stylesheets, `util.jsx`, `tokens.test.js` | — |
| 2 | Look/Layout preference modules + Settings controls | `theme/look.js`, `theme/layout.js`, `theme/uiPrefs.js`, tests, `main.jsx`, `Settings.jsx` | — |
| 3 | Professional stylesheet | `theme/professional.css`, `main.jsx` import | 1, 2 |
| 4 | Conversation store + shared list | `conversationStore.js`, test, `ConversationList.jsx`, `ConversationSidebar.jsx`, `Chat.jsx` | — |
| 5 | Chat-first shell | `ChatFirstShell.jsx`, `ChatSidebar.jsx`, `StatusPill.jsx`, `chat-sidebar.css`, `App.jsx`, `Chat.jsx` (`embedded`) | 2, 4 |
| 6 | Docs | `docs/Designs/*` | 3, 5 |

1, 2, and 4 run in parallel in separate worktrees with non-overlapping files.
3 lands after 1 and 2; 5 after 2 and 4. Each workstream is an orch leaf under
one epic; each lands on `main` through `worktree-merge.sh` once its tests and
the UI build are green in its worktree.

## Open assumptions

- Kiosk follows the Look default and therefore turns Professional on the next
  deploy. If the appliance display should stay glass, pin it by provisioning
  `?look=classic` in the kiosk URL.
- The calmer default accent under Professional applies only when no site
  theme is active; site-theme accents are used exactly as the theme declares
  them.
