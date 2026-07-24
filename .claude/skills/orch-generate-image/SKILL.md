---
name: orch-generate-image
description: "Generate branded images during task execution using the orch image generation system. Use when: user says 'generate image', 'create image', 'make an image', 'hero image', 'generate a branded image', 'create a diagram', 'generate diagram', or wants to produce any kind of AI-generated image (hero/artistic, diagram, or general-purpose). For UI mockups specifically, use orch-create-mockup instead."
visibility: public
allowed-tools: Bash
argument-hint: "<prompt or description of the desired image>"
---

# Generate Branded Image

Generate AI images (hero/artistic, diagrams, or general-purpose) using the `orch image` CLI commands. Automatically resolves project branding and waits for the result.

## What This Skill Does

The user describes an image they want generated, and this skill:

1. Determines the appropriate job type (hero, diagram) from context
2. Resolves project branding automatically
3. Builds and executes the appropriate `orch image` CLI command
4. Waits for the image to be ready (up to 120s)
5. Returns the attachment URL for embedding in task output

## Process

### 1. Parse the Request

Analyze the user's message to determine:

- **Prompt**: The image description (required)
- **Job type**: Choose based on keywords and intent:
  - `generate` (hero) — artistic images, illustrations, hero banners, backgrounds, marketing visuals, icons
  - `diagram` — architecture diagrams, flowcharts, sequence diagrams, entity relationships, system diagrams
- **Style preferences**: quality (`standard` or `hd`), style keywords
- **Size**: If mentioned (e.g., "banner" implies wide like `1920x480`, "square" implies `1024x1024`). Default: `1024x1024`
- **Format**: `png` (default), `jpeg`, `webp`, `svg`. For diagrams, consider `mermaid` if the user wants editable source
- **Task ID**: If working in context of an orch task, include `--task <id>` to link the image

### 2. Resolve Project Context

Check if a project is linked to get branding:

```bash
# Get project info
orch status --json
```

If a project is linked, check for available branding:

```bash
# List branding entries
orch branding list --json
```

If branding is found, use the first available entry (or one the user specifies) via `--branding <slug>`.

If no branding is found, proceed without `--branding` — the image will be generated without brand styling.

### 3. Build and Execute the CLI Command

#### For hero/artistic images (`generate`):

```bash
# 1) Kick off the job (generate returns immediately with a job id — there is NO
#    --wait flag on `generate`).
orch image generate "<prompt>" \
  --branding <slug> \
  --size <width>x<height> \
  --format <format> \
  --task <task-id> \
  --json
#    Capture data.job.id from the output.
#    QUALITY: omit --quality unless you know the target model's valid values —
#    they are MODEL-SPECIFIC. dall-e-3: standard|hd. gpt-image-2: low|medium|
#    high|auto (it REJECTS 'hd'/'standard' and hard-fails the job). When unsure,
#    omit --quality and let the default apply.

# 2) Wait for completion (the --wait flag lives on `status`, not `generate`).
orch image status <jobId> --wait --json
#    Capture data.attachmentId.

# 3) (optional) Land the finished image on disk:
orch attachments download <attachmentId> -o <path>.png
```

#### For diagrams:

```bash
orch image diagram "<description>" \
  --branding <slug> \
  --format <format> \
  --task <task-id> \
  --json
# then, as above: orch image status <jobId> --wait --json
```

For diagrams, if the user wants editable source, use `--format mermaid`. Otherwise use `png` or `svg`.

### 4. Handle the Result

`orch image status <jobId> --wait` blocks until the image is ready or times out
(default 120s). (`generate`/`diagram` themselves return immediately with a job
id — they have no `--wait` flag.)

**On success**: Extract the attachment id/URL from the status JSON and present it to the user:
- Show the attachment URL
- Show the job ID for reference
- If linked to a task, mention the task association

**On error**: Check the error type and provide guidance:
- **"No provider configured"** — Tell the user to configure an image provider: `orch image config set <type>.provider <provider-key-id>`
- **"Branding not found"** — The specified branding slug doesn't exist. List available brandings or suggest creating one with `/orch-create-branding`
- **"Rate limited"** — The provider is rate-limited. Suggest waiting or using a different provider
- **"Timeout"** — The job is still processing. Provide the job ID so the user can check later: `orch image status <job-id> --wait`

### 5. Report Result

Format the output clearly:

```
Image generated successfully.
- Job ID: <job-id>
- Attachment URL: <url>
- Size: <width>x<height>
- Branding: <slug or "none">
```

If working in context of an orch task, also report progress:

```bash
orch tasks progress <task-id> "Generated image: <brief-description>. Attachment: <url>" --json
```

## Size Hints

When the user doesn't specify a size, infer from context:

| Context | Suggested Size |
|---------|---------------|
| Hero banner | `1920x1080` |
| Social media header | `1500x500` |
| Square icon/avatar | `512x512` |
| Blog post image | `1200x630` |
| Diagram | `1200x800` |
| Default | `1024x1024` |

## Examples

**User**: "Generate a hero image of a futuristic city skyline at dusk"
```bash
orch image generate "a futuristic city skyline at dusk, cinematic lighting, detailed architecture" \
  --branding <auto-resolved> --size 1920x1080 --json    # then: orch image status <jobId> --wait --json
```

**User**: "Create a diagram showing the authentication flow"
```bash
orch image diagram "authentication flow with OAuth2, showing client, auth server, resource server, token exchange, and session management" \
  --format png --branding <auto-resolved> --json         # then: orch image status <jobId> --wait --json
```

**User**: "Make an image for the landing page, something with mountains"
```bash
orch image generate "mountain landscape with dramatic lighting, suitable for a landing page hero section" \
  --branding <auto-resolved> --size 1920x800 --json      # then: orch image status <jobId> --wait --json
```
