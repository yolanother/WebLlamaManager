# Download page: recommended models and fit-ranked quantizations

The Download page (`ui/src/pages/Download.jsx`, route `/download`) is where GGUF
models come from HuggingFace onto this box. Since 2026-09-01 every repository —
not only DeepSeek V4 — gets the same treatment: the server ranks each
quantization, says whether it fits this machine, and names one recommended pick;
the page renders those verdicts and routes each download to the right place.

## Page layout (top to bottom)

1. **Active Downloads** — live progress for every in-flight `hf download`
   (from the stats WebSocket), including the gated-model token prompt.
2. **Recommended models** — a chip row (`RECOMMENDED_REPOS` in
   `ui/src/pages/download-helpers.js`). Clicking a chip opens that repo's
   quantization view directly; no search needed. Current chips: DeepSeek V4 Flash
   (`antirez/deepseek-v4-gguf`), Muse Glimmer 30B (vision)
   (`unsloth/Muse-Glimmer-30B-GGUF`), and the three embedding models. The
   `#ds4` anchor sits above this row so `/download#ds4` still lands here.
3. **Search** — the HuggingFace GGUF search; results open the same repo view.
4. **Repo view** — for the selected repo: a **Recommended** row with a
   `Download recommended — <quant> (<size>)` button, then the other quantizations
   that fit, then the ones that do not (greyed, `does not fit — can OOM`,
   `Unavailable`), then `mmproj (vision)` rows, then the custom-pattern row.
   DS4 repos additionally show the `exclusive engine` badge and the ds4 directory.

## The API contract

`GET /api/repo/:author/:model/files` (`api/server.js`, logic in
`api/repo-recommendations.js`) returns:

```json
{
  "engine": "llama" | "ds4",
  "ggufDir": "…",                       // ds4 only
  "recommended": "UD-Q8_K_XL" | null,
  "quantizations": [{
    "quantization": "UD-Q8_K_XL",       // quant token, or file stem for kind file/mmproj
    "kind": "quant" | "file" | "mmproj",
    "files": ["…"], "totalSize": 0, "isSplit": false, "totalParts": 1,
    "pattern": "*UD-Q8_K_XL*.gguf",     // the HF --include glob for exactly this entry
    "rank": 8,
    "fit": { "fits": true, "requiredBytes": 0, "budgetBytes": 0, "reason": "fits" },
    "present": false                    // already in the ds4 dir (ds4 only)
  }]
}
```

Entries arrive sorted: fitting first by rank descending, then non-fitting by
rank, with mmproj entries last. `recommended` is the first fitting `kind:'quant'`
entry.

### Ranking

Rank is the quant's bit depth: `Q8`→8, `Q6`→6, … `Q2`→2; `IQn`→n−0.5 (half a
step below the same-numbered Q); `F16`/`BF16`/`F32`→5.5, so a 16-bit file is
recommended only when nothing quantized above Q5 fits. Ties break toward the
larger file (`UD-Q8_K_XL` over `Q8_0`). Unsloth's `UD-` prefix is kept in the
token.

### Fit

- **llama engine:** `checkModelFit` from `api/resource-guard.js` with
  `fileBytes = totalSize`, the guard's minimum context (4096), and both
  `availableBytes` and `totalBytes` set to the machine's model-memory
  **capacity** — `max(vram, min(gtt, total RAM))` for an integrated GPU, else
  total RAM (`computeCapacityBytes`). Capacity, not current free memory, so a
  quant that fits still shows as fitting while another model is loaded.
- **ds4 repos** (any repo in `config.ds4.allowedRepos`): `fits` when
  `totalSize <= capacity × 0.70`. This is a deliberate flat heuristic
  (`DS4_HEADROOM_FRACTION`) calibrated to the known outcomes on the 128 GB Strix
  Halo: the 86.7 GB imatrix IQ2XXS fits, the 97.6 GB and 164 GB variants do not.
  DS4 file names carry tokens that only *look* like quants (`-F32` on the MTP
  file, `-F16HC` on the Q4K-experts variant), so ds4 repos are never grouped by
  token: every file is its own `kind:'file'` entry, fitting files sort by size
  (weights first, MTP/vision/support files after), and `recommended` is the file
  a ds4 preset is configured to run (`modelPath`), else the largest fitting file
  whose name says `imatrix`, else the largest fitting file. The response also
  flags entries already `present` in the ds4 directory.

### Grouping

Files whose name carries a recognized quant token are grouped by that token
(split `-0000N-of-0000M` parts summed). Files with no recognizable token —
DS4's `…IQ2XXS-w2Q2K-AProjQ8…` names, `dflash-kquant.gguf` — are no longer
dropped: each becomes its own `kind:'file'` entry whose `pattern` is the exact
filename. `mmproj*` files are `kind:'mmproj'` and are never folded into a quant
group (previously `mmproj-…-BF16.gguf` was counted as a third BF16 part).

## Downloads

`downloadRequests()` in `download-helpers.js` builds the POSTs: `/api/pull
{repo, pattern}` for llama repos, `/api/ds4/download {repo, pattern}` for ds4
repos (allowlisted server-side, hard-pinned to the ds4 directory). **Download
recommended** for a vision repo also queues the first mmproj entry, so Muse
Glimmer arrives with `mmproj-Muse-Glimmer-30B-BF16.gguf` and the router
auto-detects image support.

## Tests

- `api/repo-recommendations.test.js` — ranking, fit (both engines, real Muse
  Glimmer and DS4 file lists and sizes), grouping fallbacks, sort order,
  recommended pick at 133.6 GB and 24 GB capacity.
- `ui/src/pages/download-helpers.test.js` — partitioning, graceful handling of
  the old response shape, download routing and the mmproj bundle.

Run with `node --test api/*.test.js` and `cd ui && npm test`.
