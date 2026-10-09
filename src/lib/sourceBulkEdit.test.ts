import { describe, expect, it } from 'vitest';
import {
  buildSourceUpdateBody,
  checkEligibility,
  computeNextRulesets,
  currentRulesets,
  currentStaleFlushMs,
  filterSources,
  planChanges,
  sameRulesets,
  sourceTypes,
  summarizePlan,
  supportsStaleFlush,
  validateStaleFlushMs,
  STALE_FLUSH_MAX_MS,
} from './sourceBulkEdit';
import type { StreamInput } from '../api/types';

/** Build a Source. `tcp` is breaker-capable; `syslog` is not (per the generated list). */
function src(id: string, extra: Partial<StreamInput> = {}): StreamInput {
  return { id, type: 'tcp', ...extra } as StreamInput;
}

describe('currentRulesets', () => {
  it('reads an existing list', () => {
    expect(currentRulesets(src('a', { breakerRulesets: ['x', 'y'] }))).toEqual(['x', 'y']);
  });

  it('treats a missing or malformed value as empty', () => {
    expect(currentRulesets(src('a'))).toEqual([]);
    expect(currentRulesets(src('a', { breakerRulesets: 'nope' }))).toEqual([]);
    expect(currentRulesets(src('a', { breakerRulesets: null }))).toEqual([]);
  });

  it('drops non-string entries', () => {
    expect(currentRulesets(src('a', { breakerRulesets: ['x', 7, null, 'y'] }))).toEqual(['x', 'y']);
  });
});

describe('currentStaleFlushMs', () => {
  it('reads a number and ignores anything else', () => {
    expect(currentStaleFlushMs(src('a', { staleChannelFlushMs: 5000 }))).toBe(5000);
    expect(currentStaleFlushMs(src('a'))).toBeUndefined();
    expect(currentStaleFlushMs(src('a', { staleChannelFlushMs: '5000' }))).toBeUndefined();
  });
});

describe('computeNextRulesets — edit modes', () => {
  it('replace swaps in the selection and keeps its order', () => {
    expect(computeNextRulesets(['a', 'b'], 'replace', ['z', 'y'])).toEqual(['z', 'y']);
  });

  it('replace dedupes the selection', () => {
    expect(computeNextRulesets([], 'replace', ['a', 'b', 'a'])).toEqual(['a', 'b']);
  });

  it('replace with an empty selection empties the list', () => {
    expect(computeNextRulesets(['a'], 'replace', [])).toEqual([]);
  });

  it('append adds only new rulesets, after the existing ones', () => {
    expect(computeNextRulesets(['a', 'b'], 'append', ['c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('append dedupes against existing entries without reordering them', () => {
    expect(computeNextRulesets(['a', 'b'], 'append', ['b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('append dedupes within the selection too', () => {
    expect(computeNextRulesets(['a'], 'append', ['c', 'c', 'b'])).toEqual(['a', 'c', 'b']);
  });

  it('append is a no-op when everything is already present', () => {
    expect(computeNextRulesets(['a', 'b'], 'append', ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('remove drops the selected rulesets and keeps the remaining order', () => {
    expect(computeNextRulesets(['a', 'b', 'c'], 'remove', ['b'])).toEqual(['a', 'c']);
  });

  it('remove ignores rulesets that are not present', () => {
    expect(computeNextRulesets(['a'], 'remove', ['zzz'])).toEqual(['a']);
  });

  it('remove can empty the list', () => {
    expect(computeNextRulesets(['a', 'b'], 'remove', ['a', 'b'])).toEqual([]);
  });

  it('clear empties the list regardless of selection', () => {
    expect(computeNextRulesets(['a', 'b'], 'clear', ['a'])).toEqual([]);
    expect(computeNextRulesets([], 'clear', [])).toEqual([]);
  });

  it('preserves order precisely — order decides precedence', () => {
    // First match wins in Cribl, so a reordered selection is a real change.
    expect(computeNextRulesets(['a', 'b'], 'replace', ['b', 'a'])).toEqual(['b', 'a']);
    expect(sameRulesets(['a', 'b'], ['b', 'a'])).toBe(false);
  });
});

describe('checkEligibility', () => {
  it('accepts a breaker-capable type', () => {
    expect(checkEligibility(src('a', { type: 'tcp' }))).toEqual({ eligible: true });
  });

  it('rejects a type that does not support Event Breakers, with a reason', () => {
    const result = checkEligibility(src('a', { type: 'syslog' }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toContain('syslog');
  });

  it('rejects a Source with no type', () => {
    const result = checkEligibility({ id: 'a' } as StreamInput);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/no type/i);
  });

  it('agrees with the generated list for known types', () => {
    // Spot-check representative members of each set (see breakerCapableTypes.ts).
    for (const t of ['tcp', 'file', 'splunk_hec', 's3', 'collection']) {
      expect(checkEligibility(src('a', { type: t })).eligible).toBe(true);
    }
    for (const t of ['syslog', 'kafka', 'http', 'metrics', 'datagen']) {
      expect(checkEligibility(src('a', { type: t })).eligible).toBe(false);
    }
  });
});

describe('supportsStaleFlush / validateStaleFlushMs', () => {
  it('follows the generated capability list', () => {
    expect(supportsStaleFlush(src('a', { type: 'tcp' }))).toBe(true);
    expect(supportsStaleFlush(src('a', { type: 'syslog' }))).toBe(false);
  });

  it('enforces the spec bounds', () => {
    expect(validateStaleFlushMs(5000)).toBeNull();
    expect(validateStaleFlushMs(10)).toBeNull();
    expect(validateStaleFlushMs(STALE_FLUSH_MAX_MS)).toBeNull();
    expect(validateStaleFlushMs(9)).toMatch(/between/);
    expect(validateStaleFlushMs(STALE_FLUSH_MAX_MS + 1)).toMatch(/between/);
    expect(validateStaleFlushMs(1.5)).toMatch(/whole number/);
    expect(validateStaleFlushMs(Number.NaN)).toMatch(/must be a number/);
  });
});

describe('buildSourceUpdateBody — lossless payloads', () => {
  it('keeps every unknown field untouched', () => {
    const original = src('tcp_in', {
      type: 'tcp',
      host: '0.0.0.0',
      port: 9000,
      pipeline: 'pl_a',
      nested: { tls: { disabled: true }, keep: [1, 2] },
      breakerRulesets: ['old'],
    });
    const body = buildSourceUpdateBody(original, ['new1', 'new2']);
    expect(body).toEqual({
      id: 'tcp_in',
      type: 'tcp',
      host: '0.0.0.0',
      port: 9000,
      pipeline: 'pl_a',
      nested: { tls: { disabled: true }, keep: [1, 2] },
      breakerRulesets: ['new1', 'new2'],
    });
  });

  it('does not mutate the original Source', () => {
    const original = src('a', { breakerRulesets: ['old'] });
    buildSourceUpdateBody(original, ['new']);
    expect(original.breakerRulesets).toEqual(['old']);
  });

  it('removes the field entirely when the list is empty', () => {
    const body = buildSourceUpdateBody(src('a', { breakerRulesets: ['old'] }), []);
    expect('breakerRulesets' in body).toBe(false);
  });

  it('sets staleChannelFlushMs only when provided', () => {
    const original = src('a', { staleChannelFlushMs: 1000 });
    expect(buildSourceUpdateBody(original, ['r']).staleChannelFlushMs).toBe(1000);
    expect(buildSourceUpdateBody(original, ['r'], 7000).staleChannelFlushMs).toBe(7000);
  });
});

describe('planChanges — diff, no-op and ineligible detection', () => {
  const sources = [
    src('tcp_a', { breakerRulesets: ['keep'] }),
    src('tcp_b', { breakerRulesets: ['target'] }),
    src('sys_c', { type: 'syslog' }),
  ];

  it('computes a before/after diff per Source', () => {
    const rows = planChanges(sources, { mode: 'append', selected: ['extra'] });
    expect(rows[0].before).toEqual(['keep']);
    expect(rows[0].after).toEqual(['keep', 'extra']);
    expect(rows[0].changed).toBe(true);
  });

  it('marks ineligible Sources as skipped with the type reason and no diff', () => {
    const rows = planChanges(sources, { mode: 'replace', selected: ['x'] });
    const ineligible = rows[2];
    expect(ineligible.changed).toBe(false);
    expect(ineligible.skipReason).toContain('syslog');
    expect(ineligible.after).toEqual(ineligible.before);
  });

  it('marks no-op Sources as skipped', () => {
    const rows = planChanges([src('a', { breakerRulesets: ['same'] })], {
      mode: 'replace',
      selected: ['same'],
    });
    expect(rows[0].changed).toBe(false);
    expect(rows[0].skipReason).toBe('No change');
  });

  it('treats a removal of something absent as a no-op', () => {
    const rows = planChanges([src('a', { breakerRulesets: ['x'] })], {
      mode: 'remove',
      selected: ['not-there'],
    });
    expect(rows[0].changed).toBe(false);
  });

  it('counts a reorder as a change', () => {
    const rows = planChanges([src('a', { breakerRulesets: ['x', 'y'] })], {
      mode: 'replace',
      selected: ['y', 'x'],
    });
    expect(rows[0].changed).toBe(true);
  });

  it('a staleChannelFlushMs change alone makes an otherwise no-op row a change', () => {
    const rows = planChanges([src('a', { breakerRulesets: ['same'], staleChannelFlushMs: 1000 })], {
      mode: 'replace',
      selected: ['same'],
      staleFlushMs: 9000,
    });
    expect(rows[0].changed).toBe(true);
    expect(rows[0].beforeStaleMs).toBe(1000);
    expect(rows[0].afterStaleMs).toBe(9000);
  });

  it('setting staleChannelFlushMs to its current value is still a no-op', () => {
    const rows = planChanges([src('a', { breakerRulesets: ['same'], staleChannelFlushMs: 1000 })], {
      mode: 'replace',
      selected: ['same'],
      staleFlushMs: 1000,
    });
    expect(rows[0].changed).toBe(false);
  });

  it('never applies staleChannelFlushMs to an unsupported type', () => {
    const rows = planChanges([src('c', { type: 'syslog' })], {
      mode: 'append',
      selected: [],
      staleFlushMs: 9000,
    });
    expect(rows[0].changed).toBe(false);
    expect(rows[0].afterStaleMs).toBeUndefined();
  });

  it('summarizes changed / skipped / ineligible counts', () => {
    const rows = planChanges(
      [...sources, src('tcp_d', { breakerRulesets: ['extra'] })],
      { mode: 'append', selected: ['extra'] },
    );
    // tcp_a + tcp_b change; sys_c ineligible; tcp_d already has it (no-op).
    expect(summarizePlan(rows)).toEqual({ total: 4, changed: 2, skipped: 2, ineligible: 1 });
  });
});

describe('filterSources / sourceTypes', () => {
  const sources = [
    src('tcp_prod', { type: 'tcp' }),
    src('file_logs', { type: 'file' }),
    src('sys_edge', { type: 'syslog' }),
  ];

  it('lists distinct types, sorted', () => {
    expect(sourceTypes(sources)).toEqual(['file', 'syslog', 'tcp']);
    expect(sourceTypes([{ id: 'x' } as StreamInput])).toEqual([]);
  });

  it('filters by case-insensitive id or type substring', () => {
    expect(filterSources(sources, 'PROD', '').map((s) => s.id)).toEqual(['tcp_prod']);
    expect(filterSources(sources, 'file', '').map((s) => s.id)).toEqual(['file_logs']);
    expect(filterSources(sources, '', '').length).toBe(3);
  });

  it('filters by exact type, and combines both filters', () => {
    expect(filterSources(sources, '', 'tcp').map((s) => s.id)).toEqual(['tcp_prod']);
    expect(filterSources(sources, 'edge', 'tcp')).toEqual([]);
  });
});
