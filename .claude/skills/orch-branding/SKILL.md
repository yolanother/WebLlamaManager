---
name: orch-branding
description: "Work with a project's EXISTING branding in orchestrator: show its resolved design system, apply or switch a corporate/base brand, customize it with project-level overrides (colors, typography, assets, voice), generate a color scheme or favicons/logo, view its DESIGN.md, and RENDER the resolved tokens into the codebase (CSS variables, Tailwind config, theme files). Use when the user says: 'apply branding', 'use our brand colors', 'match the brand', 'switch this project to the netflix brand', 'set up theming / Tailwind / CSS variables from our branding', 'show/what branding is configured', 'customize the project's colors', 'add a project logo', 'generate favicons', 'tweak the brand for this app', or references design tokens/themes for a project that has (or should inherit) branding. Projects inherit a GLOBAL corporate brand and layer their own overrides — this skill manages that on a project. NOT for authoring a brand-new brand or capturing an external company's design from scratch (use orch-create-branding), nor for one-off images or UI mockups (orch-generate-image / orch-create-mockup)."
visibility: public
allowed-tools: Bash, Read, Write, Edit
argument-hint: "[slug] — optional: apply this branding (e.g. 'netflix') to the project first, then show resolved branding"
---

# Project Branding

Manage and consume a project's branding. Branding in orchestrator is **layered**: a project inherits a **global/corporate base** brand and layers **project-level overrides** (colors, typography, assets, voice) on top — overrides and the project's own generated assets take priority over the inherited base. This skill shows, applies, customizes, and renders that resolved system.

> Authoring a *new* brand from a brief, or capturing an external company's design? That's **orch-create-branding**. This skill works with branding that already exists in the library / on the project.

## Show the resolved branding

The resolved branding = base entry + project overrides + folded project assets. Always prefer the project-scoped resolve so you see what the project actually uses:

```bash
orch branding show --project <projectId> --json    # resolved: colors, typography (named scale), components, assets
orch branding show --json                           # if the repo is linked to a project, no id needed
```

If it reports no branding configured, the project has no base and no overrides yet — offer to **apply a base** (below) or to author one with **orch-create-branding**.

## Apply / switch a base brand (inheritance)

Point the project at a library brand (e.g. a corporate base like `netflix` or `doubling-technologies`). The project inherits it; existing project overrides are preserved on top.

```bash
orch branding list --graphql "{ slug name scope }"        # browse available bases
orch branding apply <slug> --project <projectId> [--force] # --force if a brand is already set
```

## Customize for this project (overrides win over the base)

Layer project-specific changes without touching the shared base. Overrides merge by color/asset **name** over the inherited entry.

```bash
orch branding edit --project <projectId> \
  --color 'primary=#1B5CFF:primary' --color 'surface=#0E1116:background' \
  --asset 'logo-mark=https://…/logo.svg:logo,navbar' \
  --typography 'heading=Inter' --typography 'mono="JetBrains Mono"' \
  --application-prompt "Project-specific voice / usage notes." --json
```

Other customization paths:
- **AI color scheme (fast brain):** generate a palette + typography from a prompt and apply it as overrides — `POST /branding/project/:id/generate-scheme` (or, in the design agent, the `set_project_color_scheme` tool). Good for "make this app's colors warmer" without hand-picking hexes.
- **Product logo/marks:** `orch branding generate-logo <slug> --style logo|icon|wordmark --project <projectId> --generate`. Generation is fine for a *product's own* mark; never regenerate a corporate logo (inherit the real one from the base).
- **Favicons:** `orch branding favicons --project <projectId> -o <dir>` renders a full favicon set from the active app icon.

## View / export the DESIGN.md

```bash
orch branding export-design-md <slug>                              # the base entry's DESIGN.md
# project-resolved DESIGN.md (base + overrides + project assets):
#   GET /api/v1/branding/<slug>/export/design-md?projectId=<projectId>
```
Use this to hand a coherent design system to a downstream agent or to review what the project resolves to.

## Format for agent consumption

When an agent needs the brand to build with, render the resolved JSON as a compact brief:

```
## Project Branding: <name>

### Colors
- <name> (<role>): <hex> — <description>

### Typography
- Named scale: <token> = <fontFamily> <fontSize>/<lineHeight> <fontWeight> (letterSpacing)
- Families: heading <…>, body <…>, mono <…>

### Components
- <component>: <key tokens / token refs>

### Assets
- <name> [<tags>] (<format>): <url> — <usage>

### Application Instructions
<applicationPrompt verbatim>
```

## Render branding INTO the codebase

This is the payoff: translate the resolved tokens into the project's real theme so the brand actually shows up. Read the codebase first to match its conventions, then:

- **CSS variables** — emit `:root { --color-primary: …; --radius-md: …; --font-heading: …; }` from the colors/rounded/spacing/typography tokens; map component tokens to component classes.
- **Tailwind** — extend `theme.colors`, `fontFamily`, `borderRadius`, `spacing` in the Tailwind/`@theme` config from the tokens (resolve `{token.path}` references to concrete values).
- **Favicons / logo / banner** — place the favicon set + the resolved logo/marketing assets into the app's `public/` (or equivalent) and wire them up.

Resolve token references (`{colors.primary}`, `{typography.label-md}`) to concrete values when generating code. Match the project's existing token naming where one already exists rather than inventing a parallel system.

## What good looks like

- You always show/act on the **resolved** project branding (base + overrides + project assets), not just the base entry.
- Overrides are used for project-specific tweaks; the shared corporate base is left intact.
- Rendered code matches the project's existing conventions and resolves all token references to real values.
