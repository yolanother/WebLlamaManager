---
name: orch-dev-config
description: "Safely read and write configuration files (.env, JSON configs), orchestrator settings, and project tokens. Masks sensitive values automatically. ALWAYS use this instead of reading .env files directly. Triggers for any .env access, config file reading, setting API keys, checking ports, or managing secrets."
visibility: public
allowed-tools: Bash, Read
argument-hint: "[env|file|setting|project] [list|get|set] [key] [value]"
---

# Configuration Management Skill

You are managing configuration files safely. **NEVER read .env or config files directly** — always use `dev-config.sh` which masks sensitive values.

## CRITICAL SAFETY RULES

- **NEVER** use `cat`, `Read`, `grep`, `Grep`, or any file-reading tool on `.env` files
- **NEVER** pipe `.env` files through any command
- **ALWAYS** use `.orchestrator/scripts/dev-config.sh` for ALL config access
- Sensitive values (TOKEN, SECRET, KEY, PASSWORD, CREDENTIAL, API_KEY) are automatically masked

## Available Scopes

### env — .env file management
```bash
.orchestrator/scripts/dev-config.sh env list                          # View all (sensitive masked)
.orchestrator/scripts/dev-config.sh env get ANTHROPIC_API_KEY         # Get single value (masked if sensitive)
.orchestrator/scripts/dev-config.sh env set ANTHROPIC_API_KEY sk-...  # Set a value
.orchestrator/scripts/dev-config.sh env delete OLD_KEY                # Remove a key
```

### file — Generic config file management (.env, .json)
```bash
.orchestrator/scripts/dev-config.sh file list config.json             # View contents (auto-detects format)
.orchestrator/scripts/dev-config.sh file get config.json key.path     # Get value (dotted path for JSON)
.orchestrator/scripts/dev-config.sh file set config.json key.path val # Set value
.orchestrator/scripts/dev-config.sh file formats                      # List supported formats
.orchestrator/scripts/dev-config.sh file check-format file.json       # Check if format is supported
```

### setting — Orchestrator API settings
```bash
.orchestrator/scripts/dev-config.sh setting list                      # View all settings
.orchestrator/scripts/dev-config.sh setting get GITHUB_TOKEN          # Get specific setting
.orchestrator/scripts/dev-config.sh setting set GITHUB_TOKEN ghp_...  # Set a setting
```

### project — Project token management
```bash
.orchestrator/scripts/dev-config.sh project list                      # View projects with token status
.orchestrator/scripts/dev-config.sh project set-token <id> ghp_...    # Set GitHub token for a project
```

## How to Use

```bash
.orchestrator/scripts/dev-config.sh $ARGUMENTS
```
