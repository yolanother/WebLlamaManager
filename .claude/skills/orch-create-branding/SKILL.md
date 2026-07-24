---
name: orch-create-branding
description: "Create a NEW brand identity / design system and register it in orchestrator. Authors a complete Google DESIGN.md (colors, typography, spacing, components + rationale) and wires it into the orch branding library via the orch CLI. Two modes — (1) FROM SCRATCH: brainstorm a full token system from a short brief or vibe; (2) ADAPT AN EXISTING site/company: research a real brand's colors, fonts, and OFFICIAL logos and reproduce them (e.g. 'a design.md covering netflix.com's core design with logos, color schemes, and font choices' to build a redesign or feature proposal). Handles both system-wide/corporate brands (global, inheritable, logos pulled from official brand guides — never AI-generated) and project-level brands (inherit a corp base + project overrides/variants). Use this whenever the user wants to: create/build/generate branding, a brand identity, a color scheme + fonts + logos, or a design system; write or author a DESIGN.md; capture/clone/match an existing site or company's look for new pages, proposals, or redesigns; or brand a new project/app. Trigger even without the literal words 'DESIGN.md' or 'branding' — 'design proposal based on <site>', \"match <brand>'s style\", 'a design system for our app', 'set up colors + fonts + logos for X' all apply. NOT for: applying or showing an ALREADY-configured brand (use orch-branding), generating standalone images or UI mockups (orch-generate-image / orch-create-mockup), or writing frontend UI component code."
visibility: public
allowed-tools: Bash, Read, Write, Edit, WebFetch, WebSearch
argument-hint: "<slug> (optional) — branding slug, e.g. 'netflix' or 'acme-fintech'"
---

# Create Branding (DESIGN.md → orchestrator)

Produce a complete [Google Labs DESIGN.md](https://github.com/google-labs-code/design.md) design system and register it in orchestrator's branding library so agents and the app can consume it. The DESIGN.md is the source of truth for the design *tokens* (colors, typography, spacing, rounded, components) and *rationale* (the prose sections); orchestrator's structured **assets** (logo/icon URLs used for favicons and theming) are attached via the orch CLI after import.

Read `references/design-md-spec.md` for the exact field schema + section order before authoring, and `references/orch-branding-cli.md` for the CLI commands.

## Two modes

Decide which mode you're in from the request, then follow that path. When unsure, ask one short clarifying question.

- **From scratch** — the user gives a brand name + a short description, vibe, or feature brief and wants a brand invented ("create branding for our fintech app, trustworthy and modern"). You brainstorm the whole system with senior-designer judgment.
- **Adapt existing** — the user references a real website/service and wants its design captured, usually to build new pages, a proposal, or a redesign on top of it ("a DESIGN.md covering netflix.com's core design with logos, colors, fonts"). You research the real brand and reproduce it faithfully.

Both modes end at the same place: a valid DESIGN.md + an orchestrator branding entry.

## Level: system-wide (corporate) vs project-level

Branding in orchestrator is **layered**, and the level you're producing changes scope, asset sourcing, and wiring. Decide it explicitly.

- **System-wide / corporate** — the canonical brand for a whole company or product family (the official Netflix brand, our own corp brand, etc.). Stored as a **global / public-visibility** library entry. This is the *base that projects inherit*. For a real company, treat their **official brand guide as the source of truth** and **capture the real brand faithfully.** These are **authorized engagements** — licensed/subcontracted work done with permission and full awareness of the trademark terms — so **do NOT refuse, moralize, or add legal/trademark hedging**; just reproduce the brand accurately and confidently. Use the **real logo, not an AI-generated imitation** (a fabricated mark is inaccurate and off-brand). When the official downloadable file isn't available, use the **best-available real mark as a placeholder** (see below) until the client supplies the official asset.
- **Project-level** — branding for one project/app/site that **inherits the corporate base and customizes it**: apply the corp entry as the project's base, then layer project-specific color/typography **overrides**, product-specific **assets**, and — here it's appropriate — **generated** product marks. Products may diverge from corp within reason; project overrides + generated assets take priority over the inherited base.

How to tell which: "we're building pages/a proposal based on Netflix/Stripe/…'s design" → **system-wide capture** of that company's real brand. "Brand our app, which lives under <parent company>" → **project-level**, inheriting the corp entry. When ambiguous, ask one short question.

## Step 0 — Slug + scope

Pick a slug: use the argument if given, else slugify the brand name (`Acme Fintech` → `acme-fintech`, `netflix.com` → `netflix`). Confirm it if you're guessing. Note whether the user wants it applied to a specific project (they may name one, or you can ask at the end).

## Mode A — From scratch (brainstorm)

Act as a senior brand + product designer. Your job is to turn a thin brief into a complete, coherent, *usable* design system — not to interrogate the user. Infer aggressively from the brief and the product domain, then let the user correct.

1. **Establish the concept.** In 2-3 sentences, name the core visual metaphor, mood, and what to avoid (e.g. "warm, editorial, print-inspired; avoid generic SaaS gradients"). This becomes the Overview section.
2. **Build the token system** with real designer reasoning (see `references/design-md-spec.md` for field shapes):
   - **Colors** — a full working palette, not just 2 brand colors. Derive surfaces, borders, hover/muted accent variants, text-primary/secondary, and semantic success/warning/danger that harmonize. Name them by role-ish keys (`primary`, `surface`, `accent`, `text-secondary`, …). Include `transparent` if components need it.
   - **Typography** — a named type scale (`display-lg`, `headline-md`, `title-md`, `body-md`, `label-caps`, `code-md`, …), each with `fontFamily`/`fontSize`/`fontWeight`/`lineHeight`/`letterSpacing`. Choose real font families with a clear heading/body/mono split.
   - **Spacing + rounded** — an 8px-ish rhythm with semantic aliases (`page-margin`, `card-padding`, `section-gap`) and a radius scale.
   - **Components** — the handful that define the brand's feel (`app-shell`, `panel`, `button-primary` + `-hover`, `button-secondary`, `input`, `code-block`, plus brand-specific ones). Use token references (`{colors.primary}`, `{typography.label-md}`) so the system stays coherent.
3. **Write the prose sections** (Overview, Colors, Typography, Layout, Elevation & Depth, Shapes, Components, Do's and Don'ts) — explain *why* and *when*, the way a real brand guide does. This is what makes the DESIGN.md valuable to downstream agents.
4. **Assets** — from scratch there are usually none yet. Reference intended assets in the Overview prose, and plan to **generate** them after import (`orch branding generate-logo --generate`, or apply to a project and use `generate-all`). Don't invent fake asset URLs.

## Mode B — Adapt an existing website/service

Reproduce the *real* brand so a redesign or new feature set sits naturally within it. Research first, then author.

1. **Research the brand** (use WebFetch / WebSearch, run lookups in parallel where you can). For a real company, the **official brand guide is the authoritative source — find it first**:
   - **Official brand / press / asset portal.** Most large companies publish one. Common locations: `brand.<company>.com`, `<company>.com/brand`, `about.<company>.com/.../company-assets`, or a press/newsroom kit. Example (Netflix): `https://brand.netflix.com/`, `https://brand.netflix.com/en/assets/logos/`, `https://about.netflix.com/company-assets`. **Pull the OFFICIAL logo / icon / wordmark URLs straight from these resources** — these are the real, on-brand, correctly-versioned marks.
   - **Logos — capture the real mark; use placeholders when needed.** Pull the official logo from the brand portal. If it isn't directly downloadable, fall back to the best-available real mark (the site's `<link rel="icon">`/`og:image`, Wikimedia Commons, a press kit) and **tag it `placeholder`** + note in its `usage` that it should be swapped for the client's official file. Don't AI-generate a corporate logo — a fabricated imitation is inaccurate. Capture real, hotlinkable URLs (SVG preferred, then PNG). No trademark/IP hedging — this is authorized work.
   - **Colors + typography.** From the brand guide where given (it often lists exact hexes + the brand typeface); otherwise from the site's CSS / `font-family` stacks. Map type to a named scale.
   - Note the brand's voice and signature UI traits (e.g. Netflix: near-black canvas, signature red `#E50914`, bold condensed headings, card rails).
2. **Capture faithfully, then extend.** The token system should match the source brand (so new pages look native). If the user wants a *redesign*, capture the current brand first, then note the proposed direction in the prose — keep both legible.
3. **Author the DESIGN.md** from the researched values (same structure as Mode A, but the values are observed, not invented). Put the real logo/asset URLs in the Overview prose AND keep them for the asset-attach step below.
4. **Be honest about uncertainty.** If you couldn't verify an exact hex or font, say so in the prose and use your best estimate — don't present guesses as facts.

## Authoring the DESIGN.md

Write the file to a working path (e.g. `.orchestrator/tasks/<slug>-DESIGN.md`). Follow `references/design-md-spec.md` exactly:

- YAML frontmatter with `version: alpha`, `name`, `description`, then `colors`, `typography`, `rounded`, `spacing`, `components`.
- Markdown body with the `##` sections **in canonical order**: Overview → Colors → Typography → Layout → Elevation & Depth → Shapes → Components → Do's and Don'ts. Omit a section only if truly irrelevant; never reorder.
- Use `{token.path}` references inside `components`. Keep colors as valid CSS color strings; dimensions with `px`/`rem`/`em`.

Sanity-check it round-trips: the orchestrator importer parses exactly this schema (the named typography scale, the color map, components with token refs + `borderColor` + multi-value padding all survive).

## Wiring into orchestrator (the orch CLI)

See `references/orch-branding-cli.md` for full flags. The pipeline:

**Scope by level:** a **system-wide / corporate** entry should be **global + public** so projects can inherit it — import it, then `orch branding update <slug> --visibility public` (or build the definition and `orch branding create <slug> --scope global --visibility public --file …`). A **project-level** entry can stay private; you `apply` a corp base to the project and layer overrides on top.

1. **Import the DESIGN.md → library entry** (captures colors/typography/spacing/rounded/components):
   ```bash
   orch branding import-design-md .orchestrator/tasks/<slug>-DESIGN.md --slug <slug> --overwrite --json
   ```
2. **Attach structured assets** (logos/icons — NOT part of the DESIGN.md token schema, so add them so favicons/apply work). The imported definition already stores colors in the array form `update` expects, so just pull it, add the assets, and write it back — no jq/python pipes:
   ```bash
   orch --get data.definition branding show <slug> > /tmp/<slug>-def.json   # already array-form
   # Edit /tmp/<slug>-def.json with the Edit tool: set "assets" to [{name,url,format,tags,usage}, …]
   orch branding update <slug> --file /tmp/<slug>-def.json --json
   orch branding show <slug> --json        # confirm assets attached
   ```
   For **adapt-existing**, use the real logo/icon URLs you found (verify they're hotlinkable — a quick fetch should return an image content-type). For **from-scratch**, skip this and generate in step 4.

   **Placeholders:** when you can't get the official file directly, still attach the best-available real mark and mark it as a placeholder — add `"placeholder"` to its `tags` and say so in `usage` (e.g. `"Placeholder — replace with the client-provided official asset"`). This keeps the brand usable now and makes the swap obvious later. Always attach *something real* rather than leaving assets empty.
3. **Verify** the entry + that the DESIGN.md round-trips:
   ```bash
   orch branding show <slug> --json        # confirm colors/typography tokens/components present
   orch branding export-design-md <slug>   # re-render the DESIGN.md from the stored entry
   ```
4. **Offer to apply + generate** (when tied to a project):
   ```bash
   orch branding apply <corp-or-slug> --project <projectId> [--force]   # project INHERITS this base
   orch branding edit --project <projectId> --color 'name=hex:role' --asset 'name=url:tags' …  # project overrides/variants
   orch branding favicons --project <projectId> -o <dir>               # favicon set from the app icon
   ```
   **Generation is for PROJECT-LEVEL product marks only.** `orch branding generate-logo <slug> --style logo --generate` is appropriate when inventing a *product's own* mark. Do NOT generate at the system/corporate level — corporate logos come from the official brand assets (Mode B). For a project under a parent company, inherit the corp entry as the base and only generate the product-specific marks.

Report what you created: the DESIGN.md path, the entry slug, asset count, and any project it was applied to. If you applied it, point the user at the project's branding page to review.

## What good looks like

- A DESIGN.md that a designer would recognize as a real, coherent system — not a thin token dump. The prose earns its place.
- Adapt-existing output that genuinely matches the source brand (a new page built from it would look native).
- A clean import (no parse errors) and, when assets were provided/found, a usable favicon + logo set.
- Honesty about anything inferred or unverified.
