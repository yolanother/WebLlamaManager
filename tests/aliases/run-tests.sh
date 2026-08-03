#!/bin/bash
# Llama Manager — model alias groups black-box API smoke tests.
# Copyright (c) Llama Manager project. Use of this file is governed by the
# LICENSE file in the repository root.
#
# Boots the real api/server.js against a disposable CONFIG_PATH on a free port
# and drives the HTTP surface of the model alias groups feature end to end: the
# one-time boot migration that folds `backend.modelMapping` and the legacy
# defaultBigModel/defaultSmallModel keys into `config.aliases`, the
# /api/aliases CRUD endpoints and their persistence across a restart, the
# `status: 'alias'` rows in /v1/models, and the `modelMapping` / /api/settings
# back-compat views that external clients still depend on. Never reads or writes
# the repository's real config.json and never binds the dev server's port; the
# server process is torn down on both success and failure.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES="$HERE/fixtures"
PROBE="$FIXTURES/json-probe.mjs"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/alias-api-test.XXXXXX")"
CFG="$WORK/config.json"
RESP="$WORK/resp.json"
SRV_LOG="$WORK/server.log"
PASS_FILE="$WORK/pass"; FAIL_FILE="$WORK/fail"; : > "$PASS_FILE"; : > "$FAIL_FILE"
SRV_PID=""

# Backend ids and legacy targets — must mirror fixtures/seed-config.mjs.
BORETHRAX='borethrax-ollama-mnfmirep'
DAHAKA='dahaka-ollama-mngx88pk'
EMBER='ember-mpleee8f'
BIG_TARGET='Unsloth_gpt-oss-120b-GGUF_Q5_K_M_gpt-oss-120b-Q5_K_M'
SMALL_TARGET='Qwen_Qwen3-8B-GGUF'
ACCEPTS_ANY_TARGET='qwen3-8b-jetson:latest'
NEW_BIG_TARGET='Qwen_Qwen3-30B-A3B-GGUF'

# ── process + port plumbing ──────────────────────────────────────────────────

# Stop the server under test and remove the disposable work tree. Runs on every
# exit path, including a failed assertion or an interrupt, so no orphaned node
# process survives the suite. A work tree with failures is kept so its config
# and server log can be inspected; a clean run leaves nothing behind.
cleanup() {
    stop_server
    if [ -s "$FAIL_FILE" ]; then
        printf 'kept for inspection: %s (server log: %s)\n' "$WORK" "$SRV_LOG"
    else
        rm -rf "$WORK"
    fi
}
trap cleanup EXIT INT TERM

# Report whether nothing is listening on a loopback TCP port. Args: port.
port_free() { ! ( exec 3<>"/dev/tcp/127.0.0.1/$1" ) 2>/dev/null; }

# Print an unused high loopback port, avoiding the dev server's normal ports.
pick_port() {
    local p
    while :; do
        p=$(( 20000 + RANDOM % 9000 ))
        if port_free "$p"; then printf '%s' "$p"; return; fi
    done
}

API_PORT="$(pick_port)"
LLAMA_PORT="$(pick_port)"
EMBED_PORT="$(pick_port)"

# Write a fresh pre-alias config over the disposable CONFIG_PATH.
seed_config() { node "$FIXTURES/seed-config.mjs" "$CFG"; }

# Boot api/server.js against the disposable config and wait for it to listen.
# Every mutable runtime path is redirected into $WORK so the run cannot touch
# the checkout or the operator's real state. Returns non-zero if it never came up.
start_server() {
    printf '\n===== boot =====\n' >> "$SRV_LOG"
    AUTO_START=false \
    EMBED_ENABLED=false \
    CONFIG_PATH="$CFG" \
    API_PORT="$API_PORT" \
    LLAMA_PORT="$LLAMA_PORT" \
    EMBED_PORT="$EMBED_PORT" \
    HOME="$WORK/home" \
    MODELS_DIR="$WORK/models" \
    LLAMA_MANAGER_CONFIG_DIR="$WORK/etc" \
    LLAMA_MANAGER_DATA_DIR="$WORK/data" \
    LLAMA_MANAGER_CACHE_DIR="$WORK/cache" \
        node "$REPO_ROOT/api/server.js" >> "$SRV_LOG" 2>&1 &
    SRV_PID=$!
    local i
    for i in $(seq 1 60); do
        curl -sf -m 2 "http://127.0.0.1:$API_PORT/api/llm-logs?limit=1" >/dev/null 2>&1 && return 0
        kill -0 "$SRV_PID" 2>/dev/null || { SRV_PID=""; return 1; }
        sleep 0.5
    done
    return 1
}

# Terminate the server under test, escalating to SIGKILL if it ignores SIGTERM.
stop_server() {
    [ -n "$SRV_PID" ] || return 0
    kill "$SRV_PID" 2>/dev/null
    local i
    for i in $(seq 1 20); do
        kill -0 "$SRV_PID" 2>/dev/null || break
        sleep 0.25
    done
    kill -9 "$SRV_PID" 2>/dev/null
    wait "$SRV_PID" 2>/dev/null
    SRV_PID=""
}

# Reseed the pre-alias config and boot a server on it. Args: test description.
fresh_server() {
    stop_server
    seed_config
    if ! start_server; then
        printf 'F' >> "$FAIL_FILE"
        printf '  FAIL %s\n       server did not start; tail of %s:\n' "$1" "$SRV_LOG"
        tail -n 15 "$SRV_LOG" | sed 's/^/       /'
        return 1
    fi
    return 0
}

# ── HTTP + assertion helpers ─────────────────────────────────────────────────

# Issue a request against the server under test, leaving the body in $RESP and
# the status code in $HTTP_CODE. Args: method, path, optional JSON body.
req() {
    local method="$1" path="$2" body="${3:-}"
    if [ -n "$body" ]; then
        HTTP_CODE="$(curl -s -m 15 -o "$RESP" -w '%{http_code}' -X "$method" \
            -H 'content-type: application/json' -d "$body" "http://127.0.0.1:$API_PORT$path")"
    else
        HTTP_CODE="$(curl -s -m 15 -o "$RESP" -w '%{http_code}' -X "$method" \
            "http://127.0.0.1:$API_PORT$path")"
    fi
}

# Evaluate a JS expression (with the document bound to `d`) against a JSON file.
# Args: file, expression.
probe() { node "$PROBE" get "$1" "$2" 2>&1; }

# Print the sorted alias names, or one alias's `host|model` target lines, from a
# JSON document. Args: file, optional alias name.
aliases_of() { node "$PROBE" aliases "$@" 2>&1; }

# Assert string equality. Args: description, expected, actual.
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf 'F' >> "$FAIL_FILE"
        printf '  FAIL %s\n       expected: %q\n       actual:   %q\n' "$desc" "$expected" "$actual"
    fi
}

# Assert a haystack contains a fixed substring. Args: description, haystack, needle.
assert_has() {
    local desc="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf 'F' >> "$FAIL_FILE"
        printf '  FAIL %s\n       wanted substring: %s\n       in: %s\n' "$desc" "$needle" "$haystack"
    fi
}

# Assert a haystack lacks a fixed substring. Args: description, haystack, needle.
assert_not_has() {
    local desc="$1" haystack="$2" needle="$3"
    if printf '%s' "$haystack" | grep -qF -- "$needle"; then
        printf 'F' >> "$FAIL_FILE"
        printf '  FAIL %s\n       unexpected substring: %s\n       in: %s\n' "$desc" "$needle" "$haystack"
    else
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    fi
}

# Assert a newline-separated list contains an exact line. Args: description,
# list, line. Used for `host|model` target lists, where a substring check would
# let a prefix such as `qwen3:8b` match the longer `qwen3:8b-v2`.
assert_line() {
    local desc="$1" list="$2" line="$3"
    if printf '%s\n' "$list" | grep -qFx -- "$line"; then
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    else
        printf 'F' >> "$FAIL_FILE"
        printf '  FAIL %s\n       wanted line: %s\n       in: %s\n' "$desc" "$line" "$list"
    fi
}

# Assert a newline-separated list lacks an exact line. Args: description, list, line.
assert_no_line() {
    local desc="$1" list="$2" line="$3"
    if printf '%s\n' "$list" | grep -qFx -- "$line"; then
        printf 'F' >> "$FAIL_FILE"
        printf '  FAIL %s\n       unexpected line: %s\n       in: %s\n' "$desc" "$line" "$list"
    else
        printf 'P' >> "$PASS_FILE"; printf '  ok   %s\n' "$desc"
    fi
}

# Assert the last response carried a 2xx status. Args: description.
assert_2xx() {
    case "$HTTP_CODE" in
        2*) printf 'P' >> "$PASS_FILE"; printf '  ok   %s (%s)\n' "$1" "$HTTP_CODE" ;;
        *)  printf 'F' >> "$FAIL_FILE"
            printf '  FAIL %s\n       expected 2xx, got %s: %s\n' "$1" "$HTTP_CODE" "$(head -c 200 "$RESP" 2>/dev/null)" ;;
    esac
}

# Assert the last response was rejected with a 4xx status. Args: description.
assert_4xx() {
    case "$HTTP_CODE" in
        4*) printf 'P' >> "$PASS_FILE"; printf '  ok   %s (%s)\n' "$1" "$HTTP_CODE" ;;
        *)  printf 'F' >> "$FAIL_FILE"
            printf '  FAIL %s\n       expected 4xx, got %s: %s\n' "$1" "$HTTP_CODE" "$(head -c 200 "$RESP" 2>/dev/null)" ;;
    esac
}

# ── tests ────────────────────────────────────────────────────────────────────

# Boot against a pre-alias config and assert the one-time migration folded every
# modelMapping and legacy default key into config.aliases, then assert a second
# boot against the already-migrated file changes nothing.
test_boot_migration() {
    printf 'test_boot_migration\n'
    fresh_server 'boot migration' || return

    assert_eq "config gains an aliases table" "object" "$(probe "$CFG" 'Array.isArray(d.aliases)?"array":typeof d.aliases')"

    local names
    names="$(aliases_of "$CFG")"
    assert_has "migrated alias for the shared remote model" "$names" "$SMALL_TARGET"
    assert_has "migrated alias for the per-host model" "$names" "gemini-4-12b"
    assert_has "seeded default-big alias" "$names" "default-big"
    assert_has "seeded default-small alias" "$names" "default-small"
    assert_not_has "catch-all is not migrated as an alias" "$names" '*'

    assert_eq "both hosts fold into one alias, in directory order" \
        "$BORETHRAX|qwen3-vl:8b
$DAHAKA|qwen3:8b" "$(aliases_of "$CFG" "$SMALL_TARGET")"
    assert_eq "single-host alias keeps its target" \
        "$BORETHRAX|gemma4:12b" "$(aliases_of "$CFG" 'gemini-4-12b')"
    assert_eq "default-big seeded from the legacy key as a local target" \
        "local|$BIG_TARGET" "$(aliases_of "$CFG" 'default-big')"
    assert_eq "default-small seeded from the legacy key as a local target" \
        "local|$SMALL_TARGET" "$(aliases_of "$CFG" 'default-small')"

    assert_eq "no backend retains modelMapping" "0" \
        "$(probe "$CFG" 'd.backends.directory.filter(b => b.modelMapping !== undefined).length')"
    assert_eq "catch-all host becomes acceptsAny" "$ACCEPTS_ANY_TARGET" \
        "$(probe "$CFG" "d.backends.directory.find(b => b.id === '$EMBER').acceptsAny")"
    assert_eq "non-catch-all host gets no acceptsAny" "undefined" \
        "$(probe "$CFG" "d.backends.directory.find(b => b.id === '$BORETHRAX').acceptsAny")"
    assert_eq "legacy defaultBigModel key removed" "undefined" "$(probe "$CFG" 'd.defaultBigModel')"
    assert_eq "legacy defaultSmallModel key removed" "undefined" "$(probe "$CFG" 'd.defaultSmallModel')"

    # Idempotency: the migrated file must survive a second boot unchanged.
    stop_server
    cp "$CFG" "$WORK/after-boot1.json"
    if start_server; then
        cp "$CFG" "$WORK/after-boot2.json"
        assert_eq "restart against a migrated config changes nothing" "same" \
            "$(node "$PROBE" equal "$WORK/after-boot1.json" "$WORK/after-boot2.json" 2>&1)"
    else
        printf 'F' >> "$FAIL_FILE"; printf '  FAIL server did not restart on the migrated config\n'
    fi
    stop_server
}

# Exercise the /api/aliases CRUD surface: listing, multi-target creation,
# persistence across a restart, validation rejections, and deletion.
test_aliases_crud() {
    printf 'test_aliases_crud\n'
    fresh_server 'aliases CRUD' || return

    req GET /api/aliases
    assert_2xx "GET /api/aliases responds"
    local listed
    listed="$(aliases_of "$RESP")"
    assert_has "listing includes a migrated alias" "$listed" "gemini-4-12b"
    assert_has "listing includes default-big" "$listed" "default-big"
    assert_has "listing includes default-small" "$listed" "default-small"

    local multi
    multi='{"targets":[{"host":"local","model":"gemma4-12b-chat"},{"host":"'"$BORETHRAX"'","model":"gemma4:*"}]}'
    req PUT /api/aliases/conversational-model "$multi"
    assert_2xx "PUT creates a multi-target alias"

    req GET /api/aliases
    assert_eq "created alias keeps its local + remote targets in order" \
        "local|gemma4-12b-chat
$BORETHRAX|gemma4:*" "$(aliases_of "$RESP" 'conversational-model')"

    # Persistence: the alias must come back after a full restart.
    stop_server
    if start_server; then
        req GET /api/aliases
        assert_eq "created alias survives a server restart" \
            "local|gemma4-12b-chat
$BORETHRAX|gemma4:*" "$(aliases_of "$RESP" 'conversational-model')"
    else
        printf 'F' >> "$FAIL_FILE"; printf '  FAIL server did not restart after creating an alias\n'
        return
    fi

    req PUT /api/aliases/auto '{"targets":[{"host":"local","model":"gemma4-12b-chat"}]}'
    assert_4xx "reserved name 'auto' is rejected"
    req PUT /api/aliases/default-router '{"targets":[{"host":"local","model":"gemma4-12b-chat"}]}'
    assert_4xx "reserved name 'default-router' is rejected"
    req PUT /api/aliases/empty-group '{"targets":[]}'
    assert_4xx "empty targets array is rejected"

    req GET /api/aliases
    assert_not_has "rejected alias was not persisted" "$(aliases_of "$RESP")" "empty-group"

    req DELETE /api/aliases/conversational-model
    assert_2xx "DELETE removes an alias"
    req GET /api/aliases
    assert_not_has "deleted alias is gone from the listing" "$(aliases_of "$RESP")" "conversational-model"

    stop_server
}

# Assert /v1/models advertises every configured alias as a `status: 'alias'` row,
# and stops advertising one that has been deleted.
test_v1_models_advertises_aliases() {
    printf 'test_v1_models_advertises_aliases\n'
    fresh_server 'v1/models alias rows' || return

    req PUT /api/aliases/conversational-model \
        '{"targets":[{"host":"local","model":"gemma4-12b-chat"},{"host":"'"$BORETHRAX"'","model":"gemma4:*"}]}'
    assert_2xx "created an alias to advertise"

    req GET /v1/models
    assert_2xx "GET /v1/models responds"
    local models
    models="$(node "$PROBE" models "$RESP" 2>&1)"
    assert_has "default-big advertised as an alias" "$models" "default-big|alias"
    assert_has "default-small advertised as an alias" "$models" "default-small|alias"
    assert_has "migrated alias advertised" "$models" "gemini-4-12b|alias"
    assert_has "shared-model alias advertised" "$models" "$SMALL_TARGET|alias"
    assert_has "newly created alias advertised" "$models" "conversational-model|alias"

    req DELETE /api/aliases/conversational-model
    assert_2xx "deleted the advertised alias"
    req GET /v1/models
    assert_not_has "deleted alias no longer advertised" "$(node "$PROBE" models "$RESP" 2>&1)" "conversational-model"

    stop_server
}

# Assert the deprecated `modelMapping` field still reads back on GET /api/backends
# and still writes through on PUT /api/backends/:id, now via the alias table.
test_model_mapping_back_compat() {
    printf 'test_model_mapping_back_compat\n'
    fresh_server 'modelMapping back-compat' || return

    req GET /api/backends
    assert_2xx "GET /api/backends responds"
    assert_eq "synthesized mapping keeps the shared model target" "qwen3-vl:8b" \
        "$(probe "$RESP" "d.backends.find(b => b.id === '$BORETHRAX').modelMapping['$SMALL_TARGET']")"
    assert_eq "synthesized mapping keeps the per-host model target" "gemma4:12b" \
        "$(probe "$RESP" "d.backends.find(b => b.id === '$BORETHRAX').modelMapping['gemini-4-12b']")"
    assert_eq "synthesized mapping has exactly the migrated keys" "2" \
        "$(probe "$RESP" "Object.keys(d.backends.find(b => b.id === '$BORETHRAX').modelMapping).length")"
    assert_eq "acceptsAny surfaces back as the '*' mapping key" "$ACCEPTS_ANY_TARGET" \
        "$(probe "$RESP" "d.backends.find(b => b.id === '$EMBER').modelMapping['*']")"

    req PUT "/api/backends/$DAHAKA" \
        '{"modelMapping":{"'"$SMALL_TARGET"'":"qwen3:8b-v2","conversational-remote":"llama3:8b"}}'
    assert_2xx "PUT /api/backends/:id still accepts modelMapping"

    req GET /api/aliases
    local folded
    folded="$(aliases_of "$RESP" "$SMALL_TARGET")"
    assert_line "written mapping updates this host's target" "$folded" "$DAHAKA|qwen3:8b-v2"
    assert_no_line "stale target for this host is replaced" "$folded" "$DAHAKA|qwen3:8b"
    assert_line "another host's target in the same group is untouched" "$folded" "$BORETHRAX|qwen3-vl:8b"
    assert_eq "a new mapping key creates a new alias" "$DAHAKA|llama3:8b" \
        "$(aliases_of "$RESP" 'conversational-remote')"

    req GET /api/backends
    assert_eq "written mapping reads back through the synthesized view" "llama3:8b" \
        "$(probe "$RESP" "d.backends.find(b => b.id === '$DAHAKA').modelMapping['conversational-remote']")"

    stop_server
}

# Assert /api/settings still reads and writes defaultBigModel/defaultSmallModel,
# now as a view onto the default-big / default-small aliases.
test_settings_back_compat() {
    printf 'test_settings_back_compat\n'
    fresh_server 'settings back-compat' || return

    req GET /api/settings
    assert_2xx "GET /api/settings responds"
    assert_eq "defaultBigModel synthesized from the alias" "$BIG_TARGET" \
        "$(probe "$RESP" 'd.settings.defaultBigModel')"
    assert_eq "defaultSmallModel synthesized from the alias" "$SMALL_TARGET" \
        "$(probe "$RESP" 'd.settings.defaultSmallModel')"

    req POST /api/settings '{"defaultBigModel":"'"$NEW_BIG_TARGET"'"}'
    assert_2xx "POST /api/settings accepts a new defaultBigModel"

    req GET /api/settings
    assert_eq "new defaultBigModel reads back" "$NEW_BIG_TARGET" \
        "$(probe "$RESP" 'd.settings.defaultBigModel')"

    req GET /api/aliases
    assert_eq "settings write is reflected in the default-big alias" "local|$NEW_BIG_TARGET" \
        "$(aliases_of "$RESP" 'default-big')"

    stop_server
}

# ── run ──────────────────────────────────────────────────────────────────────

# The server's runtime dependencies resolve from api/node_modules. A fresh git
# worktree does not have them, and the resulting ERR_MODULE_NOT_FOUND would
# otherwise surface as five identical "server did not start" failures.
if [ ! -d "$REPO_ROOT/api/node_modules" ]; then
    printf 'alias API smoke suite: %s/api/node_modules is missing.\n' "$REPO_ROOT"
    printf 'Install the server dependencies first:\n\n    npm ci --prefix %s/api\n\n' "$REPO_ROOT"
    exit 2
fi

printf 'alias API smoke suite — config %s, api port %s\n\n' "$CFG" "$API_PORT"

test_boot_migration
test_aliases_crud
test_v1_models_advertises_aliases
test_model_mapping_back_compat
test_settings_back_compat

PASS=$(wc -c < "$PASS_FILE" | tr -d ' ')
FAIL=$(wc -c < "$FAIL_FILE" | tr -d ' ')
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
