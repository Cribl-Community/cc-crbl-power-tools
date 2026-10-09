import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import { getGroupSource, listGroupBreakerRulesets, updateGroupSource } from './sourceBreakers';
import { buildSourceUpdateBody } from '../lib/sourceBulkEdit';
import { runBatch } from '../lib/batch';
import type { StreamInput } from './types';

// The api client reads window.CRIBL_API_URL (injected by the Cribl platform) and calls
// the global fetch, both of which are stubbed here so the transport layer can be tested
// without a DOM or a live Leader.
const API = 'https://leader.example.com/api/v1';

/** Build a JSON Response, as the platform proxy would return it. */
function json(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  (globalThis as { window?: unknown }).window = { CRIBL_API_URL: API };
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe('listGroupBreakerRulesets', () => {
  it('requests the group-context breakers path and returns the items', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 'rs_a' }, { id: 'rs_b' }], count: 2 }));
    const rulesets = await listGroupBreakerRulesets('my-group');

    expect(rulesets.map((r) => r.id)).toEqual(['rs_a', 'rs_b']);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/m/my-group/lib/breakers');
  });

  it('url-encodes the group id', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], count: 0 }));
    await listGroupBreakerRulesets('group with/slash');
    expect(fetchMock.mock.calls[0][0] as string).toContain('/m/group%20with%2Fslash/lib/breakers');
  });

  it('returns an empty array when the group has no rulesets', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], count: 0 }));
    await expect(listGroupBreakerRulesets('g')).resolves.toEqual([]);
  });

  it('follows pagination until a short page arrives', async () => {
    const page = (n: number) =>
      json({ items: Array.from({ length: 200 }, (_, i) => ({ id: `rs_${n}_${i}` })), count: 200 });
    fetchMock.mockResolvedValueOnce(page(0)).mockResolvedValueOnce(json({ items: [{ id: 'last' }] }));

    const rulesets = await listGroupBreakerRulesets('g');
    expect(rulesets).toHaveLength(201);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0] as string).toContain('offset=200');
  });

  it('surfaces an auth error as an ApiError with the server message', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Forbidden: missing policy' }, 403));
    await expect(listGroupBreakerRulesets('g')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      message: 'Forbidden: missing policy',
    });
  });
});

describe('getGroupSource', () => {
  it('unwraps the CountedInputResponse envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ items: [{ id: 'tcp_in', type: 'tcp', port: 9000 }], count: 1 }),
    );
    const source = await getGroupSource('g', 'tcp_in');

    expect(source).toEqual({ id: 'tcp_in', type: 'tcp', port: 9000 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/m/g/system/inputs/tcp_in');
    // Read-only: no method override means GET, and no request body.
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
  });

  it('throws a 404 ApiError when the envelope has no items', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [], count: 0 }));
    await expect(getGroupSource('g', 'ghost')).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
  });

  it('propagates a 401 as an ApiError', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'Unauthorized' }, 401));
    await expect(getGroupSource('g', 'x')).rejects.toMatchObject({ status: 401 });
  });
});

describe('updateGroupSource', () => {
  it('PATCHes the full object to the Source path', async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [{ id: 'tcp_in' }], count: 1 }));
    const original: StreamInput = {
      id: 'tcp_in',
      type: 'tcp',
      port: 9000,
      tls: { disabled: true },
      breakerRulesets: ['old'],
    } as StreamInput;

    await updateGroupSource('g', buildSourceUpdateBody(original, ['new_a', 'new_b'], 5000));

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/m/g/system/inputs/tcp_in');
    expect(init.method).toBe('PATCH');
    // The body carries every original field, with only the breaker fields changed.
    expect(JSON.parse(init.body as string)).toEqual({
      id: 'tcp_in',
      type: 'tcp',
      port: 9000,
      tls: { disabled: true },
      breakerRulesets: ['new_a', 'new_b'],
      staleChannelFlushMs: 5000,
    });
  });

  it('reports the server validation message on failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ message: 'breakerRulesets: unknown ruleset' }, 400));
    await expect(
      updateGroupSource('g', { id: 'a', type: 'tcp' } as StreamInput),
    ).rejects.toMatchObject({ status: 400, message: 'breakerRulesets: unknown ruleset' });
  });
});

describe('rate limiting (429)', () => {
  it('retries a rate-limited request and then succeeds', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Too Many Requests' }, 429))
      .mockResolvedValueOnce(json({ items: [{ id: 'a', type: 'tcp' }], count: 1 }));

    const promise = getGroupSource('g', 'a');
    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toMatchObject({ id: 'a' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up after the retry budget and surfaces the 429', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue(json({ message: 'Too Many Requests' }, 429));

    const promise = getGroupSource('g', 'a').catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);

    await expect(promise).resolves.toMatchObject({ name: 'ApiError', status: 429 });
    // Initial attempt + MAX_RETRIES.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('does not retry non-429 errors', async () => {
    fetchMock.mockResolvedValue(json({ message: 'Server error' }, 500));
    await expect(getGroupSource('g', 'a')).rejects.toMatchObject({ status: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('bulk apply — partial failure', () => {
  /** The per-Source round trip the workflow runs: GET fresh config, then PATCH it. */
  async function applyOne(gid: string, id: string, rulesets: string[]): Promise<void> {
    const fresh = await getGroupSource(gid, id);
    await updateGroupSource(gid, buildSourceUpdateBody(fresh, rulesets));
  }

  it('keeps going when one Source fails and reports per-item outcomes', async () => {
    // tcp_a: GET ok, PATCH ok | tcp_b: GET ok, PATCH 400 | tcp_c: GET ok, PATCH ok
    fetchMock
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_a', type: 'tcp' }] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_a' }] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_b', type: 'tcp' }] }))
      .mockResolvedValueOnce(json({ message: 'ruleset not found' }, 400))
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_c', type: 'tcp' }] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_c' }] }));

    const results = await runBatch(
      ['tcp_a', 'tcp_b', 'tcp_c'],
      (id) => applyOne('g', id, ['rs']),
      () => {},
    );

    expect(results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(results[1].error).toBe('ruleset not found');
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it('records a failure when the pre-read fails, without attempting the write', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ message: 'Forbidden' }, 403))
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_b', type: 'tcp' }] }))
      .mockResolvedValueOnce(json({ items: [{ id: 'tcp_b' }] }));

    const results = await runBatch(
      ['tcp_a', 'tcp_b'],
      (id) => applyOne('g', id, ['rs']),
      () => {},
    );

    expect(results[0]).toMatchObject({ ok: false, error: 'Forbidden' });
    expect(results[1].ok).toBe(true);
    // 1 failed GET for tcp_a (no PATCH), then GET + PATCH for tcp_b.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('writes nothing in dry-run mode', async () => {
    const results = await runBatch(
      ['tcp_a', 'tcp_b'],
      (id) => applyOne('g', id, ['rs']),
      () => {},
      { dryRun: true },
    );

    expect(results.every((r) => r.ok && r.dryRun)).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ApiError', () => {
  it('carries the status for callers to branch on', () => {
    const err = new ApiError('nope', 403);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(403);
  });
});
