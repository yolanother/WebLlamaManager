---
name: orch-add-feature-learning
description: "Add a learning (gotcha, workaround, config fix, etc.) to an installed feature package. Use when: user says 'add learning to feature', 'record this gotcha', 'save this workaround', 'note this about [feature]', 'learned something about [feature]', 'capture this for [feature]', 'this was tricky with [feature]', or when you discover something non-obvious during implementation that future developers should know. Trigger proactively when you hit a surprising error, find an undocumented requirement, or work around a bug in a feature."
visibility: public
allowed-tools: Bash, Read, Write, Edit
context: fork
argument-hint: "<feature-slug> <title> [--category gotcha|workaround|config-fix|dependency|compatibility|performance] [--severity info|warning|critical]"
---

# Add Feature Learning

Quickly capture a learning — a gotcha, workaround, config fix, or other non-obvious insight — and attach it to a feature package so future installations benefit from the knowledge.

Learnings are things that surprised you, cost time to debug, or required a workaround. They're saved as drafts for human review before becoming part of the feature's permanent knowledge base.

## When to Use This

- You hit a surprising error while implementing a feature
- You discovered an undocumented requirement or config step
- You had to work around a bug or limitation
- A dependency conflict or compatibility issue came up
- Performance tuning was needed that wasn't obvious
- Any "I wish I'd known this before I started" moment

## Quick Path

If the user provides a feature slug and title directly:

```bash
# Write the description to a temp file (avoids shell escaping issues)
cat > .orchestrator/tasks/learning-desc.md << 'EOF'
<detailed description of what happened, why it matters, and how to handle it>
EOF

orch features learnings add <feature-slug> \
  --title "<concise title>" \
  --file .orchestrator/tasks/learning-desc.md \
  --category <category> \
  --severity <severity> \
  --json
```

## Guided Path

If the user gives partial info, gather what's needed:

### 1. Identify the feature

If the feature slug isn't obvious from context, check what's installed:

```bash
orch features installed --json
```

### 2. Determine the learning

Ask yourself (or the user) these questions to shape the learning:

- **What happened?** — The specific error, behavior, or situation
- **Why was it surprising?** — What you expected vs what actually happened
- **How did you fix/work around it?** — The solution or workaround
- **Who needs to know?** — Anyone installing this feature in the future

### 3. Pick the right category

| Category | When to use |
|----------|-------------|
| `gotcha` | Unexpected behavior, undocumented requirement, or easy-to-miss detail |
| `workaround` | Had to work around a bug, limitation, or design constraint |
| `config-fix` | Configuration needed manual adjustment beyond what the install provides |
| `dependency` | Missing, incompatible, or version-sensitive dependency |
| `compatibility` | Framework, language, or platform compatibility issue |
| `performance` | Performance issue that required tuning or architectural change |

When in doubt, use `gotcha` — it's the broadest category and fits most surprises.

### 4. Pick severity

| Severity | Meaning |
|----------|---------|
| `info` | Good to know, saves a little time |
| `warning` | Will cause confusion or wasted effort if not known |
| `critical` | Will block progress or cause data loss if not known |

Default to `warning` if unsure — most learnings worth capturing are things that would waste meaningful time.

### 5. Write a good description

A good learning description includes:

- **Context**: What you were doing when you encountered this
- **Problem**: What went wrong or was surprising
- **Solution**: How you resolved it, with specific commands or code if applicable
- **Why**: Why this happens (root cause if known)

Keep it concise but specific enough that someone encountering the same issue can resolve it quickly.

### 6. Submit

```bash
cat > .orchestrator/tasks/learning-desc.md << 'EOF'
<description>
EOF

orch features learnings add <feature-slug> \
  --title "<title>" \
  --file .orchestrator/tasks/learning-desc.md \
  --category <category> \
  --severity <severity> \
  --json
```

## After Adding

- The learning is saved as a **draft** — it needs human review before becoming permanent
- Direct the user to the review queue: Features > Learnings in the web UI, or:
  ```bash
  orch features learnings list <feature-slug> --status draft --json
  ```
- To approve immediately (if you have admin access):
  ```bash
  orch features learnings approve <feature-slug> <learning-id> --json
  ```

## Output

After adding, confirm with:
- The learning title and category
- The feature it was attached to
- A reminder that it's in draft status pending review
