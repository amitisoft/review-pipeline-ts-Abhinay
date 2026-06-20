# Product Review Pipeline — Module Overview

## Purpose

This module is an AI-powered batch processing pipeline that uses Claude (via the Anthropic SDK) to extract structured insights from product reviews. It handles validation, retry logic, human escalation routing, and parallel execution.

---

## Files

| File | Role |
|---|---|
| [pipeline.ts](pipeline.ts) | Core pipeline logic — extraction, validation, routing, and batch execution |
| [reviews.ts](reviews.ts) | Static dataset of 10 sample reviews used as input |

---

## Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        REVIEWS[]  (input)                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              run_with_concurrency  (max 5 at once)               │
│                                                                   │
│   Spawns up to 5 parallel workers. Each worker pulls the next    │
│   unprocessed review from the queue until all are done.          │
└──────────────────────────────┬──────────────────────────────────┘
                               │  per review
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  [BATCH] Worker picks up review                                   │
│  log: "Worker picked up review (N stars)"                        │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║               STAGE 1 — EXTRACTION  [domain: EXTRACT]           ║
╠═════════════════════════════════════════════════════════════════╣
║  extract_review()                                                ║
║  • Builds prompt from review text + star rating                  ║
║  • Calls Claude with forced tool_choice: "extract_review"        ║
║  • Returns RawExtraction JSON (category, sentiment, issues,      ║
║    price, delivery, safety_concern, confidence)                  ║
║                                                                   ║
║  logs:                                                            ║
║    "Sending to Claude — attempt-1 (stars: N)"                    ║
║    "Claude returned — category, sentiment, confidence, ..."      ║
╚══════════════════════════════╦══════════════════════════════════╝
                               ║
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║              STAGE 2 — VALIDATION + RETRY  [domain: RETRY]      ║
╠═════════════════════════════════════════════════════════════════╣
║  extract_with_retry()  →  validate_extraction()                  ║
║                                                                   ║
║  Checks:                                                          ║
║    • Sentiment sign must agree with star rating (1–2★ → negative,║
║      4–5★ → positive)                                            ║
║    • sentiment_score in [-1.0, 1.0]                              ║
║    • confidence in [0.0, 1.0]                                    ║
║                                                                   ║
║  ┌─── PASS (no errors) ──────────────────────────────────────┐   ║
║  │  log: "Validation passed on first attempt"                │   ║
║  │  → proceed to Stage 3                                     │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║                                                                   ║
║  ┌─── FAIL + confidence < 0.4 ───────────────────────────────┐   ║
║  │  warn: "Confidence X is below 0.4 — skipping retry"       │   ║
║  │  → use first attempt as-is, proceed to Stage 3            │   ║
║  └───────────────────────────────────────────────────────────┘   ║
║                                                                   ║
║  ┌─── FAIL + confidence ≥ 0.4 ───────────────────────────────┐   ║
║  │  log: "Sending corrective context to Claude for retry"     │   ║
║  │  → call extract_review() again with error list + prior     │   ║
║  │    extraction as context                                   │   ║
║  │  → re-validate retry result                               │   ║
║  │    • pass: log "Retry passed validation"                  │   ║
║  │    • still fail: warn "Retry still has N error(s)"        │   ║
║  │  → proceed to Stage 3                                     │   ║
║  └───────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════╦══════════════════════════════════╝
                               ║
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║              STAGE 3A — ROUTING  [domain: ROUTE]                ║
╠═════════════════════════════════════════════════════════════════╣
║  route_to_human_review()                                         ║
║                                                                   ║
║  Routing table:                                                   ║
║  ┌────────────────────┬──────────────────┬──────────────────┐    ║
║  │ Condition          │ reason           │ recommended      │    ║
║  ├────────────────────┼──────────────────┼──────────────────┤    ║
║  │ confidence < 0.6   │ low_confidence   │ verify_          │    ║
║  │ only               │                  │ extraction       │    ║
║  ├────────────────────┼──────────────────┼──────────────────┤    ║
║  │ safety_concern     │ safety_concern   │ escalate_to_     │    ║
║  │ only               │                  │ safety_team      │    ║
║  ├────────────────────┼──────────────────┼──────────────────┤    ║
║  │ both               │ both             │ escalate_to_     │    ║
║  │                    │                  │ safety_team      │    ║
║  ├────────────────────┼──────────────────┼──────────────────┤    ║
║  │ neither            │ (no escalation)  │ auto-cleared     │    ║
║  └────────────────────┴──────────────────┴──────────────────┘    ║
║                                                                   ║
║  logs:                                                            ║
║    "Escalating to human queue — reason: X, action: Y"            ║
║    "Passed routing check — no escalation needed"                  ║
╚══════════════════════════════╦══════════════════════════════════╝
                               ║
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║              STAGE 3B — CONTEXT TRIM  [domain: TRIM]            ║
╠═════════════════════════════════════════════════════════════════╣
║  trim_for_context()                                              ║
║                                                                   ║
║  Drops:  product_category, price_mentioned, delivery_mentioned   ║
║  Keeps:  review_id, sentiment_score, issues,                     ║
║          safety_concern, confidence                              ║
║                                                                   ║
║  log: "Dropping fields: ... — keeping core 5 fields"             ║
╚══════════════════════════════╦══════════════════════════════════╝
                               ║
                               ▼
┌──────────────────────┐    ┌─────────────────────────────────────┐
│   human_review_queue │    │         processed_results[]          │
│   HumanHandoff[]     │    │         ProcessedResult[]            │
│                      │    │                                      │
│  (escalated reviews) │    │  (all successfully processed)        │
└──────────────────────┘    └─────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                       BATCH COMPLETE summary                      │
│  Total / Processed OK / Failed / Human queue / Auto-cleared      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Log Domains

Each log line is prefixed `[DOMAIN] [REVIEW_ID] message` so you can filter by stage in the terminal.

| Domain | Function | What it tells you |
|---|---|---|
| `BATCH` | `process_batch` | Worker lifecycle — review picked up, fully stored, or failed |
| `EXTRACT` | `extract_review` | Claude API calls — attempt number, raw output fields |
| `RETRY` | `extract_with_retry` | Validation pass/fail, whether retry was triggered or skipped |
| `ROUTE` | `route_to_human_review` | Escalation decision — reason and recommended action |
| `TRIM` | `trim_for_context` | Which fields were dropped before storing |

**Filter examples (terminal):**
```bash
# Watch only extraction calls
npx tsx pipeline.ts | grep '\[EXTRACT\]'

# Watch only escalations
npx tsx pipeline.ts | grep '\[ROUTE\]'

# Watch retries
npx tsx pipeline.ts | grep '\[RETRY\]'

# Watch warnings only
npx tsx pipeline.ts | grep 'WARN'
```

---

## Data Shapes

### `Review` (input, from `reviews.ts`)
```
id: string       — unique review identifier (e.g. "R001")
stars: number    — 1–5 star rating
text: string     — raw review text
```

### `RawExtraction` (Claude's output)
```
product_category: string          — e.g. "kitchen appliance"
sentiment_score: number           — -1.0 (very negative) to 1.0 (very positive)
issues: string[]                  — specific problems raised; empty array if none
price_mentioned: number | null    — dollar amount if stated, else null
delivery_mentioned: boolean | null — whether delivery was discussed
safety_concern: boolean           — true if physical danger is described
confidence: number                — model's self-reported confidence (0.0–1.0)
```

### `ProcessedResult` (trimmed for storage)
```
review_id, sentiment_score, issues, safety_concern, confidence
```
Fields like `product_category`, `price_mentioned`, and `delivery_mentioned` are dropped to reduce downstream memory/token overhead.

### `HumanHandoff` (escalation record)
```
review_id: string
reason: 'low_confidence' | 'safety_concern' | 'both'
original_text: string
extracted_data: RawExtraction
recommended_action: 'verify_extraction' | 'escalate_to_safety_team'
```

---

## Key Design Decisions

- **Forced tool use** ensures Claude always returns structured JSON — no free-text parsing needed.
- **Retry is skipped below confidence 0.4** to avoid spending extra API calls on extractions the model itself considers unreliable.
- **Context trimming** explicitly prevents unused fields from accumulating in memory or being passed to downstream agents.
- **Concurrency cap (5)** prevents rate-limit errors when scaling beyond the 10 sample reviews.
- **Local state in `process_batch`** means the function is safe to call multiple times — results never bleed across runs.
- **Second-attempt re-validation** surfaces cases where the retry still fails, rather than silently accepting a still-wrong extraction.
