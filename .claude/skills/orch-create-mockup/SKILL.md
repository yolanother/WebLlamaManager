---
name: orch-create-mockup
description: "Generate UI mockups from text descriptions or refine existing sketches into polished mockups. Use when: user says 'create mockup', 'generate mockup', 'mockup this UI', 'sketch to mockup', 'UI mockup', 'wireframe', 'design this page', 'mock up the interface', or wants to visualize a UI design. Supports both text-to-mockup and sketch-to-mockup (refinement) workflows."
visibility: public
allowed-tools: Bash
argument-hint: "<UI description or sketch file path>"
---

# Create UI Mockup

Generate UI mockups from text descriptions or refine sketches into polished designs using the `orch image` CLI commands. Automatically resolves project branding for consistent visual identity.

## What This Skill Does

The user describes a UI they want mocked up (or provides a sketch to refine), and this skill:

1. Determines the workflow: text-to-mockup or sketch-to-mockup refinement
2. Resolves project branding automatically
3. Builds and executes the appropriate CLI command
4. Waits for the mockup to be ready
5. Returns the attachment URL

## Process

### 1. Determine Workflow

Analyze the user's message to determine which path to take:

**Text-to-mockup** (use `orch image mockup`):
- User provides a description of the UI they want
- No input files referenced
- Keywords: "mockup", "design", "create UI", "page layout"

**Sketch-to-mockup** (use `orch image refine`):
- User references an existing file (sketch, wireframe, screenshot)
- Keywords: "refine this", "polish this sketch", "turn this into", "make this look professional"
- The input file path(s) are passed via `--input`

### 2. Extract Details

For **text-to-mockup**, extract:
- **UI description**: What the interface shows (layout, components, sections, data)
- **Style**: Design aesthetic keywords. Common options:
  - `modern` — clean lines, ample whitespace, contemporary components
  - `minimal` — reduced chrome, focused content, subtle colors
  - `enterprise` — dense information, data tables, professional
  - `playful` — rounded corners, bright colors, friendly
  - `dashboard` — sidebar nav, header, card grid, charts
  - `landing` — hero section, features grid, CTA, testimonials
- **Size**: Infer from the UI type (see Size Hints below)
- **Specific components**: Navigation bars, sidebars, forms, tables, cards, charts, etc.

For **sketch-to-mockup**, extract:
- **Input file paths**: One or more sketch/wireframe/screenshot files
- **Refinement instructions**: What to change, enhance, or preserve
- **Style strength** (`--strength`): How much to deviate from the input (0.0-1.0, default 0.7)
  - `0.3` — Stay very close to the sketch layout and proportions
  - `0.5` — Moderate refinement, keep major layout elements
  - `0.7` — Standard refinement, polished output (default)
  - `0.9` — Heavy transformation, use sketch as loose inspiration

### 3. Resolve Project Branding

```bash
# Check project context
orch status --json

# List available branding
orch branding list --json
```

Use the project's branding if available. The mockup will use brand colors, typography, and design tokens automatically.

### 4. Build and Execute

#### Text-to-mockup:

```bash
orch image mockup "<detailed UI description>" \
  --branding <slug> \
  --size <width>x<height> \
  --style "<style keywords>" \
  --task <task-id> \
  --wait \
  --json
```

Write a detailed, prescriptive UI description. Expand on the user's input to include:
- Layout structure (e.g., "2-column layout with 280px sidebar")
- Specific component types (e.g., "data table with 5 columns: Name, Status, Date, Amount, Actions")
- Content placeholders (e.g., "header showing 'Dashboard' with user avatar dropdown")
- Visual hierarchy (e.g., "prominent KPI cards at top, detailed table below")
- Interactive states mentioned (e.g., "active nav item highlighted with accent color")

#### Sketch-to-mockup:

```bash
orch image refine \
  --input <path-to-sketch-1> \
  --input <path-to-sketch-2> \
  --prompt "<refinement instructions>" \
  --branding <slug> \
  --style "<style keywords>" \
  --strength <0.0-1.0> \
  --task <task-id> \
  --wait \
  --json
```

### 5. Handle the Result

**On success**: Present the mockup to the user:
- Show the attachment URL
- Describe what was generated
- Suggest next steps (refine further, generate variations, implement)

**On error**: Provide actionable guidance:
- **"No provider configured"** — Tell the user to set up an image provider: `orch image config set mockup.provider <provider-key-id>`
- **"Branding not found"** — Suggest creating branding with `/orch-create-branding`
- **"Input file not found"** — Verify the sketch file path exists
- **"Timeout"** — Provide job ID for later checking: `orch image status <job-id> --wait`

### 6. Report Result

```
Mockup generated successfully.
- Job ID: <job-id>
- Attachment URL: <url>
- Size: <width>x<height>
- Style: <style>
- Branding: <slug or "none">
```

If working in context of an orch task:
```bash
orch tasks progress <task-id> "Generated UI mockup: <brief-description>. Attachment: <url>" --json
```

## Size Hints

| UI Type | Suggested Size |
|---------|---------------|
| Desktop full page | `1440x900` |
| Desktop dashboard | `1440x900` |
| Mobile screen | `390x844` |
| Tablet | `1024x768` |
| Landing page (full) | `1440x2400` |
| Component/widget | `800x600` |
| Email template | `600x800` |
| Default | `1440x900` |

## Examples

**User**: "Create a mockup of a project settings page with tabs for General, Members, and Billing"

```bash
orch image mockup "Project settings page with horizontal tab navigation showing three tabs: General (active), Members, Billing. General tab content: form with project name input, description textarea, project avatar upload, timezone dropdown, and a danger zone section with delete project button. Clean card-based layout with subtle borders." \
  --branding <auto-resolved> --size 1440x900 --style "modern, clean, SaaS dashboard" --wait --json
```

**User**: "Polish this wireframe sketch into a real mockup" (with file path)

```bash
orch image refine \
  --input /path/to/wireframe.png \
  --prompt "Transform this wireframe into a polished, production-ready UI mockup. Maintain the layout structure but add proper styling, colors, typography, icons, and realistic content placeholders." \
  --branding <auto-resolved> --style "modern, professional" --strength 0.7 --wait --json
```

**User**: "Mockup a mobile login screen with social sign-in buttons"

```bash
orch image mockup "Mobile login screen with centered card layout. Top: app logo. Below: email input field, password input field with show/hide toggle, 'Forgot password?' link. Primary 'Sign In' button full width. Divider with 'or continue with' text. Row of social buttons: Google, GitHub, Apple. Bottom: 'Don't have an account? Sign up' link." \
  --branding <auto-resolved> --size 390x844 --style "modern, minimal, mobile" --wait --json
```
