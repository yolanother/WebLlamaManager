# Jev (TypeSafe System One model)

> Research note, 2026-09-23. It covers Jev, the hosted model whose HTTP API
> llama-manager's `DECISION` engine speaks. For the open-weights model that
> actually runs locally, see [laya.md](laya.md).

## Summary

- **What it is:** Jev is TypeSafe's flagship model. TypeSafe calls it "the first
  System One model". It evaluates a `state` against typed questions and returns
  typed answers with probabilities. It does not write text, code or
  explanations.
  - "System One" refers to Kahneman's fast, intuitive System 1 thinking.
  - The docs describe it as a model for "fast, structured decisions that
    software can use directly".
- **Publisher:** TypeSafe (typesafe.ai).
  - Docs: <https://docs.typesafe.ai>
  - API host: `api.typesafe.ai`
- **License and access:** closed weights, available only as a paid hosted API.
  - Terms are TypeSafe's Master Customer Agreement, Data Processing Agreement
    and Privacy Policy.
  - TypeSafe states Jev is not trained on customer requests. Zero data
    retention is offered to enterprise customers.
  - Jev is not fine-tuned per customer: the same weights serve every account.
- **Current version:** `jev-1.13.0`. Both aliases, `jev-latest` and
  `jev-preview`, point to it as of the docs fetched 2026-09-23.
- **SDKs:**
  - Python: `typesafe_sdk` (`TypeSafeClient`)
  - JavaScript: `@typesafe-ai/sdk`
  - Rust: `typesafe-api`, linked from the laya-server README to
    `github.com/noahbclarkson/typesafe-api-rs` (not fetched)

## Capabilities and limits

From <https://docs.typesafe.ai/models> and the API reference.

### Inputs

Text only: a string, a JSON object, or an array of text values. There is no
image, audio or video input.

### Context

- 64k tokens per request (state plus all questions).
- 32k tokens for the state plus the longest single question.
- Laya, by contrast, reads only about 320–768 tokens of state.

### Question types

| Type | Criteria | Answer |
|---|---|---|
| `noul` | optional `{true, false}` descriptions | P(yes), 0–1 |
| `choice` | up to 255 options | chosen option, probabilities, confidence |
| `score` | 2–10 ordered levels | probability-weighted value, legend, probabilities, confidence |

### Languages

English is primary and best. Other languages, including CJK, "are handled but
not equally well". No per-language benchmark is published.

### Price and rate limits

- **Price:** $0.042 per million input tokens. Output tokens are free.
- **Rate limits:** 250,000 tokens per second and 1,200 requests per minute.
  These limits are "adjusting dynamically".

### Latency

- TypeSafe publishes no latency figure.
- Third-party benchmarks cited in Laya's README put Jev at 236–276 ms p50 for
  one question. That figure was not verified here.

### Known weaknesses

TypeSafe's own list is "Jev 1.13 jaggedness". Jev is weak at:

- literal reading
- math, counting and numeric values
- date comparison
- multi-hop indirection
- large states full of irrelevant detail ("context rot")
- adversarial content in the state
- contradictory instructions and criteria
- generation, which it "is not trained to" do

## Wire format

### Request

```http
POST https://api.typesafe.ai/v1/systemone
Authorization: Bearer <API_KEY>
Content-Type: application/json
```

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "model": "jev-latest",
  "questions": {
    "is_urgent":   {"type": "noul", "instructions": "Does this convey urgency?",
                    "criteria": {"true": "Explicitly time-sensitive", "false": "No urgency expressed"}},
    "department":  {"type": "choice", "instructions": "Which team should handle this?",
                    "criteria": {"billing": "Payments, invoicing, refunds", "technical": "Bugs, outages, integrations",
                                 "sales": "Pricing, upgrades, new accounts"}},
    "frustration": {"type": "score", "instructions": "How frustrated is the customer?",
                    "criteria": ["Calm", "Frustrated", "Very angry"]}
  }
}
```

- `state`, `model` and `questions` are all required by the API.
- Question ids are chosen by the caller and are not seen by the model.
- `instructions` may be a string, an object or an array. Fields inside it are
  referenced from the question text in backticks.

### Response

```json
{
  "model": "jev-1.13.0",
  "answers": {
    "is_urgent":   {"type": "noul", "noul": 0.95},
    "department":  {"type": "choice", "choice": "billing",
                    "probabilities": {"billing": 0.88, "technical": 0.12, "sales": 0.0}, "confidence": 0.81},
    "frustration": {"type": "score", "score": 1.05, "legend": {"0": "Calm", "1": "Frustrated", "2": "Very angry"},
                    "probabilities": {"0": 0.0, "1": 0.95, "2": 0.05}, "confidence": 0.92}
  },
  "usage": {"input_tokens": 296, "output_tokens": 20}
}
```

- `model` is the versioned ID that answered, even when the request used an alias.
- A `noul` answer carries no `confidence` field in the documented shape.

### Models endpoint

`GET /v1/models` returns `{"models":[{name, description, release_date}]}`.

### Errors

Errors use standard HTTP status codes with a JSON body.

| Status | Meaning |
|---|---|
| 401 | missing or invalid API key |
| 422 | validation failure (the body names the field) |
| 429 | rate limited (honour `retry-after`) |
| 529 | TypeSafe is overloaded |

The SDKs retry 429 and 529 with backoff.

## How llama-manager uses it today

**llama-manager never calls TypeSafe's hosted Jev.**

- **What it uses:** only Jev's wire format. `POST /v1/systemone` and
  `POST /api/v1/systemone` accept a Jev-shaped body and proxy it to a local
  laya-server container, so a TypeSafe client needs only its base URL changed.
- **Model rewrite:**
  - `isDecisionModel` in `api/decision.js` accepts `jev-*` names
    (`jev-latest`, `jev-1.13.0`, ...), alongside `laya` and `laya-*`.
  - `resolveForwardModel` rewrites them to `laya-<checkpoint>`
    (`laya-typed-decisions` by default).
  - laya-server is also started with `LAYA_SERVER_JEV_ALIAS=1`.
- **The answer comes from Laya, not Jev.** The response `model` is the Laya
  checkpoint, not `jev-*`.
- **Differences from real Jev:**
  - answers carry an extra `action` field
  - `usage.output_tokens` is 0
  - a `host` field is added
  - errors use laya-server's `{"detail": ...}` or llama-manager's `{"error": ...}`
  - no 429 or 529

See [laya.md](laya.md) for the routing and the files involved. The plan is
[`docs/plans/2026-09-22-laya-decision-engine.md`](../../plans/2026-09-22-laya-decision-engine.md).

## Relevance to routing / smart alias

This section is about Jev itself. What llama-manager can actually run is Laya:
see [laya.md](laya.md#relevance-to-routing--smart-alias).

**(a) Classify a prompt's difficulty or type: yes.**

- Classification is Jev's documented core use.
- TypeSafe's "Intent routing" pattern puts the request in `state` and asks, in
  one call:
  - a `choice` for intent
  - a `score` for complexity
- The answers then route the request to deterministic code, a specialist LLM
  or a human, with a confidence check on the complexity score.
- The longer context (32k state) means Jev sees the whole prompt, where Laya
  sees only the first few hundred tokens.

**(b) Pick among candidate models: indirectly, like Laya.**

- Jev has no built-in model registry.
- Candidate models can be `choice` options with descriptions, up to 255 of them.
  The docs' "skill suggestion" cookbook ranks 182 skills this way.
- TypeSafe's guidance is to keep code in control: the model makes narrow
  decisions and code maps them to handlers.

**(c) Generate a free-text answer: no.**

- The System One docs state these models "do not write replies, produce code,
  or generate explanations".
- The jaggedness page says Jev "is not trained to generate text ... there are
  other models for that".

**Practical note:** using hosted Jev for a smart alias would add a paid
external dependency and network latency (about 250 ms p50, third-party) to
every request. It would also send prompts off-box. Jev is relevant here as the
API contract that Laya imitates, not as a component we call.

## Sources

Fetched 2026-09-23:

- TypeSafe docs index: <https://docs.typesafe.ai/llms.txt>
- API reference: <https://docs.typesafe.ai/api>
- Models (price, limits, context, aliases, languages): <https://docs.typesafe.ai/models>
- System One concept: <https://docs.typesafe.ai/concepts/system-one>
- Jev 1.13 jaggedness: <https://docs.typesafe.ai/model-jaggedness/jev-1.13>
- Intent routing pattern: <https://docs.typesafe.ai/patterns/intent-routing>
- Confidence: <https://docs.typesafe.ai/confidence>
- Skill suggestion cookbook (182-option choice): <https://docs.typesafe.ai/cookbooks/skill_suggestion>
- Legal: <https://docs.typesafe.ai/legal>
- laya-server README (Jev alias, TypeSafe compatibility): <https://github.com/noahbclarkson/laya-server>

Not verified:

- Jev's latency and its benchmark scores. These come only from third-party
  repos cited in Laya's README (`AbdelStark/jev-benchmarks`,
  `nibzard/decision-model-benchmark`), which were not fetched.
- Jev's model size, architecture and hardware. TypeSafe does not publish them.
