# Local `llm` CLI

The dependency-free `llm` command is the terminal and agent interface to Llama
Manager. It provides ergonomic commands for every MCP workflow and uses the
Manager's OpenAPI document for complete current API access. `llm request` is a
future-safe escape hatch for routes added after the CLI was installed.

## Installation and connection

`./install.sh` links the source checkout's executable into `~/.local/bin/llm`.
The Debian package installs the same entrypoint as `/usr/bin/llm`. Node.js 22 is
the only runtime dependency.

The manager URL defaults to `LLAMA_MANAGER_URL`, then
`http://localhost:5250`. Override it per invocation with `--url`:

```bash
export LLAMA_MANAGER_URL=http://frostburn:5250
llm status
llm --url http://thrmogar:5250 models list
```

## Output for humans and agents

Human-readable output is the default. Use one of these stable machine modes:

```bash
llm status --json
llm models list --get 'localModels.*.name'
llm status --graphql '{ running mode loadedModels { id } }'
```

`--get` supports dotted paths and `*` list/object projection. `--graphql`
supports nested object and list selection sets. They are mutually exclusive;
invalid or absent fields return a nonzero usage error instead of silently
changing the result shape.

For self-description, `llm help --json` emits structured command metadata and
`llm docs --full` emits Markdown. Both are generated from `cli/catalog.js`, the
same catalog used by the parser, so agents do not need to scrape this page.

## Ergonomic command groups

- Health and analytics: `status`, `stats`, `analytics`
- Models: `models list|load|unload|delete`
- Runtime: `server start|stop`, `settings get|update`
- Presets: `presets list|activate`
- Discovery and installation: `search`, `repo files`, `download`,
  `downloads list|status|cancel`
- Operations: `processes list`, `logs`
- Inference: `chat`
- Complete API: `api list`, `api call OPERATION_ID`, and
  `request METHOD PATH`

Destructive ergonomic commands require `--yes`; the CLI never opens an
interactive confirmation prompt. HTTP, connection, JSON, command, and usage
failures write concise diagnostics to stderr and use a nonzero exit code. A zero
exit code means the command and any requested output projection succeeded.
Credential-like response fields are masked before output.

## Complete API, multipart, and binary operations

```bash
# Discover operation IDs from /api/openapi.json
llm api list --graphql '{ operations { operationId method path summary } }'

# Resolve an operation ID; repeat path/query/header inputs as needed
llm api call getRequestStats --query window=24h --json
llm api call getDownload --param downloadId=AUTHOR/MODEL:Q4_K_XL --json

# JSON request through the future-safe raw route, labeled for analytics
llm request POST /api/v1/chat/completions \
  --header X-Llama-Manager-Workload=repetition-assisted \
  --body '{"model":"qwen","messages":[{"role":"user","content":"Repeat A B C."}]}' \
  --json

# Multipart text/files and binary response output
llm api call createMediaArtifact --form purpose=vision --form file=@./image.png
llm request GET /api/media/artifacts/example/content --output ./artifact.bin
```

`--param` replaces an OpenAPI path parameter. `--query` and
`--header NAME=VALUE` are repeatable; headers with invalid names or embedded
newlines are rejected before HTTP. `--body` accepts JSON. `--form NAME=VALUE` adds multipart text and
`--form NAME=@FILE` adds file data. `--output FILE` writes response bytes
without corrupting them through terminal formatting.

## Qwen3.8-27B workflow

This sequence uses only the CLI and mirrors the web app's search/download flow:

```bash
llm search 'Qwen3.8 27B' --graphql '{ results { id downloads likes } }'
llm repo files unsloth/Qwen3.8-27B-GGUF \
  --graphql '{ quantizations { name files { name size } } }'

PRIMARY_ID=$(llm download unsloth/Qwen3.8-27B-GGUF \
  --filename Qwen3.8-27B-UD-Q4_K_XL.gguf --get downloadId)
llm download unsloth/Qwen3.8-27B-GGUF --filename mmproj-F16.gguf --json
llm download unsloth/Qwen3.8-27B-GGUF \
  --filename MTP/mtp-Qwen3.8-27B-Q4_0.gguf --json
llm downloads status "$PRIMARY_ID" --graphql '{ status progress error }'

llm models list --get 'localModels.*.name'
MODEL='unsloth_Qwen3.8-27B-GGUF'
llm models load "$MODEL"
llm chat "$MODEL" 'Reply with exactly: Qwen is ready.'
```

Poll `downloads status` until `status` is `completed`; if it is `failed`, the
projected `error` field contains the actionable reason. The exact local model
name is authoritative from `models list`, especially for split GGUF files.

To cancel an active transfer or delete an installed model explicitly:

```bash
llm downloads cancel "$DOWNLOAD_ID" --yes
llm models delete "$MODEL" --yes
```
