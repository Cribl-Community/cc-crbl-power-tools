// Pure logic for the Source Bulk Editor workflow.
//
// Deliberately free of React and network code so the merge rules and payload building
// can be unit-tested in isolation. The workflow component owns fetching/rendering; the
// API module owns transport. Everything here is a pure function over plain data.
//
// Ruleset ORDER is significant: Cribl applies a Source's breakerRulesets in order and
// the first matching ruleset wins. Every mode below therefore preserves a deterministic
// order rather than sorting or set-ifying the result.

import type { StreamInput } from '../api/types';
import { BREAKER_CAPABLE_TYPES, STALE_FLUSH_CAPABLE_TYPES } from './breakerCapableTypes';

/** Bulk edit operations offered for a Source's Event Breaker ruleset list. */
export type EditMode = 'replace' | 'append' | 'remove' | 'clear';

/** Spec bounds for staleChannelFlushMs (InputTcp.staleChannelFlushMs in openapi.json). */
export const STALE_FLUSH_MIN_MS = 10;
export const STALE_FLUSH_MAX_MS = 43_200_000;

const BREAKER_CAPABLE = new Set(BREAKER_CAPABLE_TYPES);
const STALE_FLUSH_CAPABLE = new Set(STALE_FLUSH_CAPABLE_TYPES);

/**
 * Read a Source's current ruleset list defensively. A Source that has never had Event
 * Breakers configured omits the field entirely, and we never want a malformed value to
 * throw mid-render, so anything that is not an array of strings reads as empty.
 */
export function currentRulesets(source: StreamInput): string[] {
  const value = source.breakerRulesets;
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Read a Source's current Event Breaker buffer timeout, if it has one set. */
export function currentStaleFlushMs(source: StreamInput): number | undefined {
  const value = source.staleChannelFlushMs;
  return typeof value === 'number' ? value : undefined;
}

/** Drop duplicates while keeping first-seen order. */
function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Apply an edit mode to a Source's existing ruleset list and return the new list.
 *
 * - `replace` — the selection becomes the whole list (deduped, selection order kept).
 * - `append`  — selected rulesets not already present are added after the existing
 *               ones; existing entries keep their position, so prior precedence wins.
 * - `remove`  — every selected ruleset is removed; the rest keep their order.
 * - `clear`   — the list becomes empty.
 */
export function computeNextRulesets(
  current: string[],
  mode: EditMode,
  selected: string[],
): string[] {
  switch (mode) {
    case 'replace':
      return dedupe(selected);
    case 'append': {
      const existing = dedupe(current);
      const have = new Set(existing);
      return [...existing, ...dedupe(selected).filter((r) => !have.has(r))];
    }
    case 'remove': {
      const drop = new Set(selected);
      return dedupe(current).filter((r) => !drop.has(r));
    }
    case 'clear':
      return [];
  }
}

export interface Eligibility {
  eligible: boolean;
  /** Human-readable reason, present only when `eligible` is false. */
  reason?: string;
}

/**
 * Whether a Source's type supports Event Breaker rulesets, per the OpenAPI-derived
 * list in breakerCapableTypes.ts. Editing an unsupported type would be rejected or
 * silently dropped by the API, so those rows are offered as disabled with a reason.
 */
export function checkEligibility(source: StreamInput): Eligibility {
  const type = source.type;
  if (!type) return { eligible: false, reason: 'Source has no type' };
  if (!BREAKER_CAPABLE.has(type)) {
    return { eligible: false, reason: `Type “${type}” does not support Event Breakers` };
  }
  return { eligible: true };
}

/** Whether a Source's type supports the staleChannelFlushMs buffer timeout. */
export function supportsStaleFlush(source: StreamInput): boolean {
  return Boolean(source.type && STALE_FLUSH_CAPABLE.has(source.type));
}

/** Validation message for a user-entered buffer timeout, or null when acceptable. */
export function validateStaleFlushMs(value: number): string | null {
  if (!Number.isFinite(value)) return 'Buffer timeout must be a number.';
  if (!Number.isInteger(value)) return 'Buffer timeout must be a whole number of milliseconds.';
  if (value < STALE_FLUSH_MIN_MS || value > STALE_FLUSH_MAX_MS) {
    return `Buffer timeout must be between ${STALE_FLUSH_MIN_MS} and ${STALE_FLUSH_MAX_MS} ms.`;
  }
  return null;
}

/**
 * Build a lossless update body: the full Source object with only the Event Breaker
 * fields changed. Every other field — including ones this app does not model — is
 * carried through untouched so a full-object PATCH never resets unrelated config.
 *
 * An empty ruleset list removes the field rather than sending `[]`, mirroring how
 * withPipeline() in api/stream.ts clears an assignment. Absent and empty mean the same
 * thing to Cribl, and omitting keeps the stored object clean.
 */
export function buildSourceUpdateBody(
  original: StreamInput,
  rulesets: string[],
  staleFlushMs?: number,
): StreamInput {
  const body: StreamInput = { ...original };
  if (rulesets.length > 0) body.breakerRulesets = rulesets;
  else delete body.breakerRulesets;
  if (staleFlushMs !== undefined) body.staleChannelFlushMs = staleFlushMs;
  return body;
}

/** True when two ruleset lists are equal in both contents and order. */
export function sameRulesets(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** One planned change, as shown in the before/after preview. */
export interface PlanRow {
  source: StreamInput;
  before: string[];
  after: string[];
  beforeStaleMs?: number;
  afterStaleMs?: number;
  /** True when this row would actually write something. */
  changed: boolean;
  /** Why the row is skipped (ineligible type, or no change). Absent when `changed`. */
  skipReason?: string;
}

export interface PlanOptions {
  mode: EditMode;
  /** Rulesets the user picked, in precedence order. Unused by `clear`. */
  selected: string[];
  /** When set, also bulk-assign this Event Breaker buffer timeout. */
  staleFlushMs?: number;
}

/**
 * Compute the before/after plan for every selected Source. Ineligible Sources and
 * no-op rows are marked skipped with a reason instead of being dropped, so the preview
 * accounts for everything the user selected.
 */
export function planChanges(sources: StreamInput[], opts: PlanOptions): PlanRow[] {
  const { mode, selected, staleFlushMs } = opts;
  return sources.map((source) => {
    const before = currentRulesets(source);
    const beforeStaleMs = currentStaleFlushMs(source);

    const eligibility = checkEligibility(source);
    if (!eligibility.eligible) {
      return {
        source,
        before,
        after: before,
        beforeStaleMs,
        afterStaleMs: beforeStaleMs,
        changed: false,
        skipReason: eligibility.reason,
      };
    }

    const after = computeNextRulesets(before, mode, selected);
    // Only apply the timeout to types that actually declare the field.
    const wantStale = staleFlushMs !== undefined && supportsStaleFlush(source);
    const afterStaleMs = wantStale ? staleFlushMs : beforeStaleMs;

    const rulesetsChanged = !sameRulesets(before, after);
    const staleChanged = wantStale && staleFlushMs !== beforeStaleMs;
    const changed = rulesetsChanged || staleChanged;

    return {
      source,
      before,
      after,
      beforeStaleMs,
      afterStaleMs,
      changed,
      skipReason: changed ? undefined : 'No change',
    };
  });
}

export interface PlanSummary {
  total: number;
  changed: number;
  skipped: number;
  ineligible: number;
}

/** Headline counts for the preview step. */
export function summarizePlan(rows: PlanRow[]): PlanSummary {
  let changed = 0;
  let ineligible = 0;
  for (const row of rows) {
    if (row.changed) changed += 1;
    else if (row.skipReason && row.skipReason !== 'No change') ineligible += 1;
  }
  return { total: rows.length, changed, skipped: rows.length - changed, ineligible };
}

/** Distinct Source types present in a list, sorted — drives the type filter dropdown. */
export function sourceTypes(sources: StreamInput[]): string[] {
  return [...new Set(sources.map((s) => s.type).filter((t): t is string => Boolean(t)))].sort();
}

/**
 * Filter Sources by a case-insensitive id/type substring and an exact type.
 * Mirrors the filtering in the bulk pipeline-assignment workflow.
 */
export function filterSources(
  sources: StreamInput[],
  text: string,
  type: string,
): StreamInput[] {
  const q = text.trim().toLowerCase();
  return sources.filter((s) => {
    if (type && s.type !== type) return false;
    if (!q) return true;
    return (
      s.id.toLowerCase().includes(q) || String(s.type ?? '').toLowerCase().includes(q)
    );
  });
}
