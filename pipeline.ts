import Anthropic from '@anthropic-ai/sdk';
import { REVIEWS, Review } from './reviews';

const client = new Anthropic();

const CONCURRENCY_LIMIT = 5;

// ─── Log helpers ─────────────────────────────────────────────────────────────

function log(domain: string, id: string, msg: string) {
  console.log(`[${domain}] [${id}] ${msg}`);
}

function warn(domain: string, id: string, msg: string) {
  console.warn(`[${domain}] [${id}] WARN: ${msg}`);
}

function logSection(title: string) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${'─'.repeat(60)}`);
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

interface RawExtraction {
  product_category: string;
  sentiment_score: number;
  issues: string[];
  price_mentioned?: number | null;
  delivery_mentioned?: boolean | null;
  safety_concern: boolean;
  confidence: number;
}

interface ProcessedResult {
  review_id: string;
  sentiment_score: number;
  issues: string[];
  safety_concern: boolean;
  confidence: number;
}

interface HumanHandoff {
  review_id: string;
  reason: 'low_confidence' | 'safety_concern' | 'both';
  original_text: string;
  extracted_data: RawExtraction;
  recommended_action: 'verify_extraction' | 'escalate_to_safety_team';
}

// ─── Tool definition ──────────────────────────────────────────────────────────

const EXTRACTION_TOOL = {
  name: "extract_review",
  description: "Extract structured insight from a product review.",
  input_schema: {
    type: "object" as const,
    properties: {
      product_category: {
        type: "string",
        description: "e.g. 'kitchen appliance', 'audio'"
      },
      sentiment_score: {
        type: "number",
        description: "Sentiment score from -1.0 (very negative) to 1.0 (very positive)"
      },
      issues: {
        type: "array",
        items: { type: "string" },
        description: "List of specific issues raised. Return an empty array [] if none — never null."
      },
      price_mentioned: {
        type: ["number", "null"],
        description: "Exact dollar amount if stated, otherwise null."
      },
      delivery_mentioned: {
        type: ["boolean", "null"],
        description: "true/false if delivery was discussed, null if not mentioned."
      },
      safety_concern: {
        type: "boolean",
        description: "true if any physical danger or hazard is described, otherwise false."
      },
      confidence: {
        type: "number",
        description: "Model's confidence in this extraction from 0.0 to 1.0"
      }
    },
    required: ["product_category", "sentiment_score", "issues", "safety_concern", "confidence"]
  }
};

// ─── Concurrency limiter ──────────────────────────────────────────────────────

// Limits concurrent API calls to avoid rate limiting on large batches.
async function run_with_concurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<unknown>
): Promise<unknown[]> {
  const results: unknown[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ─── Stage 1: Extraction ──────────────────────────────────────────────────────

async function extract_review(review: Review, error_context?: string): Promise<RawExtraction> {
  const attempt = error_context ? 'retry' : 'attempt-1';
  log('EXTRACT', review.id, `Sending to Claude — ${attempt} (stars: ${review.stars})`);

  let user_content = `Review ID: ${review.id}\nStar rating: ${review.stars}/5\n\n${review.text}`;
  if (error_context) {
    user_content = `${error_context}\n\n---\n\nOriginal review:\n${user_content}`;
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1000,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: "tool", name: "extract_review" },
    messages: [{ role: "user", content: user_content }]
  });

  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "extract_review") {
      const result = block.input as RawExtraction;
      log('EXTRACT', review.id, `Claude returned — category: "${result.product_category}", sentiment: ${result.sentiment_score}, confidence: ${result.confidence}, safety: ${result.safety_concern}, issues: ${result.issues.length}`);
      return result;
    }
  }

  throw new Error(`No tool_use block found in response for review ${review.id}`);
}

// ─── Stage 2: Validation ──────────────────────────────────────────────────────

function validate_extraction(extraction: RawExtraction, review: Review): string[] {
  const errors: string[] = [];

  if ((review.stars === 4 || review.stars === 5) && extraction.sentiment_score < 0) {
    errors.push(`You returned sentiment_score: ${extraction.sentiment_score} but this is a ${review.stars}-star review — the score must be positive (>= 0).`);
  }
  if ((review.stars === 1 || review.stars === 2) && extraction.sentiment_score > 0) {
    errors.push(`You returned sentiment_score: ${extraction.sentiment_score} but this is a ${review.stars}-star review — the score must be negative (<= 0).`);
  }
  if (extraction.sentiment_score < -1.0 || extraction.sentiment_score > 1.0) {
    errors.push(`sentiment_score must be between -1.0 and 1.0.`);
  }
  if (extraction.confidence < 0.0 || extraction.confidence > 1.0) {
    errors.push(`confidence score must be between 0.0 and 1.0.`);
  }

  return errors;
}

// ─── Stage 2: Retry orchestration ─────────────────────────────────────────────

async function extract_with_retry(review: Review): Promise<RawExtraction> {
  log('RETRY', review.id, 'Starting extraction with retry guard');

  const first_attempt = await extract_review(review);
  const errors = validate_extraction(first_attempt, review);

  if (errors.length === 0) {
    log('RETRY', review.id, 'Validation passed on first attempt — no retry needed');
    return first_attempt;
  }

  log('RETRY', review.id, `Validation failed (${errors.length} error(s)): ${errors.join(' | ')}`);

  // Skip retry when the model is already uncertain — not worth the token cost.
  if (first_attempt.confidence < 0.4) {
    warn('RETRY', review.id, `Confidence ${first_attempt.confidence} is below 0.4 — skipping retry to avoid wasted API call`);
    return first_attempt;
  }

  const error_context = [
    `Your previous extraction had the following errors:`,
    ...errors.map(err => `- ${err}`),
    `\nYour previous (incorrect) extraction was:`,
    JSON.stringify(first_attempt, null, 2),
    `\nPlease correct these discrepancies.`
  ].join('\n');

  log('RETRY', review.id, 'Sending corrective context to Claude for retry');
  const second_attempt = await extract_review(review, error_context);

  // Validate the retry result so a still-wrong second attempt doesn't silently pass.
  const retry_errors = validate_extraction(second_attempt, review);
  if (retry_errors.length > 0) {
    warn('RETRY', review.id, `Retry still has ${retry_errors.length} validation error(s): ${retry_errors.join(' | ')}`);
  } else {
    log('RETRY', review.id, 'Retry passed validation');
  }

  return second_attempt;
}

// ─── Stage 3: Context trimming ────────────────────────────────────────────────

function trim_for_context(extraction: RawExtraction, reviewId: string): ProcessedResult {
  log('TRIM', reviewId, `Dropping fields: product_category, price_mentioned, delivery_mentioned — keeping core 5 fields`);
  return {
    review_id: reviewId,
    sentiment_score: extraction.sentiment_score,
    issues: extraction.issues,
    safety_concern: extraction.safety_concern,
    confidence: extraction.confidence
  };
}

// ─── Stage 3: Human escalation routing ───────────────────────────────────────

function route_to_human_review(
  extraction: RawExtraction,
  original_review: Review,
  queue: HumanHandoff[]
): void {
  const low_confidence = extraction.confidence < 0.6;
  const safety_flag = extraction.safety_concern === true;

  let reason: 'low_confidence' | 'safety_concern' | 'both' = 'low_confidence';
  if (low_confidence && safety_flag) reason = 'both';
  else if (safety_flag) reason = 'safety_concern';

  const recommended_action = safety_flag ? 'escalate_to_safety_team' : 'verify_extraction';

  log('ROUTE', original_review.id, `Escalating to human queue — reason: "${reason}", action: "${recommended_action}"`);

  queue.push({
    review_id: original_review.id,
    reason,
    original_text: original_review.text,
    extracted_data: extraction,
    recommended_action
  });
}

// ─── Main batch coordinator ───────────────────────────────────────────────────

async function process_batch() {
  logSection(`BATCH START — ${REVIEWS.length} reviews, concurrency cap: ${CONCURRENCY_LIMIT}`);

  // Local state — safe to call process_batch() multiple times.
  const human_review_queue: HumanHandoff[] = [];
  const processed_results: ProcessedResult[] = [];

  await run_with_concurrency(REVIEWS, CONCURRENCY_LIMIT, async (review: Review) => {
    log('BATCH', review.id, `Worker picked up review (${review.stars} stars)`);

    try {
      const extraction = await extract_with_retry(review);

      if (extraction.confidence < 0.6 || extraction.safety_concern) {
        route_to_human_review(extraction, review, human_review_queue);
      } else {
        log('ROUTE', review.id, 'Passed routing check — no escalation needed');
      }

      processed_results.push(trim_for_context(extraction, review.id));
      log('BATCH', review.id, 'Review fully processed and stored');
    } catch (error) {
      console.error(`[BATCH] [${review.id}] ERROR: Processing failed —`, error);
    }
  });

  logSection('BATCH COMPLETE');
  console.log(`  Total reviews      : ${REVIEWS.length}`);
  console.log(`  Processed OK       : ${processed_results.length}`);
  console.log(`  Failed             : ${REVIEWS.length - processed_results.length}`);
  console.log(`  Human review queue : ${human_review_queue.length}`);
  console.log(`  Auto-cleared       : ${processed_results.length - human_review_queue.length}`);

  logSection('PROCESSED RESULTS');
  console.log(JSON.stringify(processed_results, null, 2));

  logSection('HUMAN REVIEW QUEUE');
  console.log(JSON.stringify(human_review_queue, null, 2));
}

process_batch();
