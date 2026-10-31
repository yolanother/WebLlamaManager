<!--
Copyright (c) Llama Manager project. Use of this file is governed by the
LICENSE file in the repository root.

Documents the GPU power-cap schedule: the `gpuPower` setting that caps every
discrete NVIDIA card at a default wattage and allows a different cap inside
hour windows (midnight-crossing, per-day, IANA timezone, highest wins on
overlap); how and when the manager enforces it; the fail-safe; the root
oneshot unit and polkit grant that let the unprivileged service write the
limit; the access rules (loopback-only writes, no cross-origin access); the
GET /api/gpu-power status shape; and how to set the hours from the UI, the
CLI and the API. Read this before changing api/gpu-power.js or the unit.
-->

# GPU Power-Cap Schedule

## Why this exists

drakemore's RTX 3090 (on OCuLink) defaults to a 420 W power limit (range 100–450 W).
Under load that overloads the operator's UPS. The schedule keeps the card at a lower
**default** cap and allows a different cap only inside the hours the operator chooses.

Scope: discrete **NVIDIA** cards, through `nvidia-smi`. A box with no NVIDIA card or no
`nvidia-smi` does nothing and says so in the status. The AMD iGPU is out of scope.

## The setting

`config.json` key `gpuPower`. It is edited through `POST /api/settings`, and the body is
**merged** over the stored block. So `{"gpuPower":{"windows":[...]}}` changes only the hours.

| Field | Type | Meaning |
|---|---|---|
| `enabled` | bool, default `false` | Off means the card is never touched. |
| `defaultWatts` | int | Cap outside every window. Required when enabled. |
| `timezone` | IANA name, default `""` | Zone the windows are read in. `""` = system zone (drakemore's is UTC, so set it). |
| `windows` | `[{start, end, watts, days?}]` | `start`/`end` are `"HH:MM"`; `days` ⊂ `sun mon tue wed thu fri sat`. |

Window rules:

- **End is exclusive.** `08:00–22:00` covers 08:00:00 through 21:59.
- **Windows may cross midnight.** `22:00–06:00` runs to 06:00 the next morning.
- **`days` names the day a window starts on.** A Friday `22:00–06:00` also covers Saturday
  00:00–05:59. Leave `days` out to mean every day.
- **`start == end` lasts 24 hours**, beginning at `start`.
- **When windows overlap, the highest watts wins.**
- **A window may be lower than the default.** Inside its hours, its cap applies.

Values are validated against the card's own `power.min_limit`/`power.max_limit`. An
out-of-range value gets a `400` that names the range, for example
`gpuPower.defaultWatts 500 W is outside this card's range 100-450 W`.

There is one shared cap for every NVIDIA card. A per-GPU override was skipped because
drakemore has one card. Add it when a box has two cards that need different caps.

## Enforcement

`api/gpu-power.js` holds the pure schedule logic and the controller. `api/server.js`
supplies the two side effects.

- **When:** on service start, immediately after a `gpuPower` settings change, and every
  60 s.
- **Only on a difference:** the controller reads `power.limit` and writes only when a
  card's limit differs from the target.
- **Clamped** to the cards' common min/max, even if a hand-edited config bypassed
  validation.
- **Logged** to the manager log and the journal (`[gpu-power]`) every time. The log line
  shows the old cap, the new cap, the reason, and which window applied:
  `GPU power cap 300 W -> 320 W (minute; window 0 12:00-12:02)`.
- **Fail-safe:** if the schedule cannot be evaluated (for example, an unknown timezone in
  a hand-edited file), the default cap is used, never a window's cap. If a write fails,
  the error appears in the status, and the next tick tries again.
- **Persistence mode** (`nvidia-smi -pm 1`) is enabled with every write, so the cap
  holds while no client has the driver open.
- **Disabling** the schedule leaves the card at whatever cap it last had.

## Privilege: the root oneshot

The manager runs as the unprivileged `llama-manager` account, and `nvidia-smi -pl` needs
root. It follows the identity-unit pattern:

- `llama-manager-gpu-power@.service` is a root `Type=oneshot` template, instance = watts.
  Without `RemainAfterExit`, every start runs again.
- `scripts/llama-manager-gpu-power <watts>` accepts only `^[0-9]{1,4}$`. It exits 0 when
  `nvidia-smi` is absent. Otherwise it runs `nvidia-smi -pm 1` and then
  `nvidia-smi -pl <watts>`, and exits with nvidia-smi's status.
- `packaging/90-llama-manager.rules` grants the `llama-manager` group **START** of
  `^llama-manager-gpu-power@[0-9]{1,4}\.service$` only. No other verb or instance is
  granted (`tests/gpu-power/polkit-rule.test.js` evaluates the rule).
- `gpuPowerUnitName()` builds the unit name, and it builds it only from an integer within
  the card range. While that range is unknown, it refuses.

## Access rules

llama-manager has no inbound authentication yet, so the gates are the same as for
`strata` and the GPU reservation routes (wider gap: task T3232ac3050828):

- **Writing `gpuPower` is loopback-only.** Off-box callers get
  `403 {code: "NOT_LOOPBACK"}`. Other settings fields keep their existing rules.
- **No cross-origin access.** A browser `Origin` whose host differs from `Host` gets
  `403 {code: "FOREIGN_ORIGIN"}`. This applies to a `gpuPower` write and to every request
  to `/api/gpu-power`, including its preflight. `/api/gpu-power` is guarded before the
  open `cors()`, so it never carries a wildcard grant. curl and the CLI send no `Origin`
  and are unaffected.
- **`GET /api/gpu-power` is read-only.** It returns the status cached by the last
  evaluation (see `checkedAt`, at most 60 s old) and never starts the unit.

From another machine, the UI panel is read-only. Edit the hours on the box's own screen,
through an SSH tunnel (`ssh -L 3001:127.0.0.1:3001 root@drakemore`, then open
`http://localhost:3001/settings/gpus`), or with curl over SSH.

## Status: `GET /api/gpu-power`

```json
{
  "enabled": true, "defaultWatts": 300, "windows": [ ... ],
  "available": true, "reason": null, "range": {"min": 100, "max": 450},
  "cards": [{"uuid": "GPU-83ea…", "name": "NVIDIA GeForce RTX 3090",
             "limitWatts": 300, "minWatts": 100, "maxWatts": 450, "drawWatts": 188.9}],
  "timezone": "America/Los_Angeles", "targetWatts": 300, "activeWindow": null,
  "nextChange": {"at": "2026-10-31T15:00:00.000Z", "watts": 350},
  "lastChange": {...}, "lastError": null, "checkedAt": "…"
}
```

`available: false` with a `reason` means there is no `nvidia-smi` or no NVIDIA card.

## Setting the hours

**UI:** Settings → **GPUs** tab → **GPU power cap** panel
(`/settings/gpus`, on the box itself). Use **+ Add window**, set start, end, watts and any
days, then **Save power cap**. The readout line shows the live limit, draw, active window
and next change.

**CLI** (on the box; `llm` defaults to `http://localhost:5250`, so point it at the
appliance port):

```bash
llm --url http://127.0.0.1:3001 gpu-power status
llm --url http://127.0.0.1:3001 gpu-power set --body '{"windows":[{"start":"08:00","end":"22:00","watts":350}]}'
```

**API** (on the box, or over `ssh drakemore`):

```bash
curl -s -X POST http://127.0.0.1:3001/api/settings -H 'content-type: application/json' \
  -d '{"gpuPower":{"enabled":true,"defaultWatts":300,"timezone":"America/Los_Angeles",
       "windows":[{"start":"08:00","end":"22:00","watts":350}]}}'
curl -s http://127.0.0.1:3001/api/gpu-power
```

## Deploying to an appliance

The API files go out with the normal `deploy-test-appliance` path (`scp api/*.js`, plus
`ui/dist`). The unit, the helper and the polkit rule are package files. Until the respin
payload ships the unit (task T3232a04cd8836), install them by hand as root:

```bash
scp 'llama-manager-gpu-power@.service' root@drakemore:/lib/systemd/system/
scp scripts/llama-manager-gpu-power root@drakemore:/usr/lib/llama-manager/scripts/
scp packaging/90-llama-manager.rules root@drakemore:/usr/share/polkit-1/rules.d/
ssh root@drakemore systemctl daemon-reload
```

A reflash loses these files until the package carries them. While they are missing, the
status shows `lastError` (the unit cannot be started), and the card stays at its boot
default of 420 W.

## Tests

- `api/gpu-power.test.js`: the schedule (timezone, midnight crossing, days, 24 h windows,
  overlap, next change across DST), validation, parsing, the controller (only-on-change,
  clamp, fail-safe, no card, failed apply), and the unit-name and Origin guards.
- `tests/gpu-power/gpu-power-api.test.js`: boots the manager with a fake `nvidia-smi` and
  a fake `systemctl`, and covers apply-on-start, settings validation, window up and back,
  a read-only GET, foreign-origin and off-box refusal.
- `tests/gpu-power/polkit-rule.test.js`: executes the polkit rule.
- `tests/gpu-power/run-tests.sh`: the root helper, with a stub `nvidia-smi`.
- `ui/src/pages/gpu-power-form.test.js`: the form mapping.
