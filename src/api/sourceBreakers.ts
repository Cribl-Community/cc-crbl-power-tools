// Event Breaker operations on Sources in a worker-group context (/m/:gid/...), for the
// Source Bulk Editor workflow.
//
// This module is additive: listing a group's Sources stays in ./stream (listGroupSources)
// and commit/deploy stay in ./destinations — both are reused as-is. What is new here is
// (a) reading a group's Event Breaker rulesets (the existing listBreakerRulesets in
// ./search is pinned to the default_search context and cannot be reused), and (b) the
// read-then-PATCH round trip for a single Source.
//
// Per openapi.json, PATCH /m/:gid/system/inputs/{id} is the only update method (there is
// no PUT), its request body is a bare Input, and both GET and PATCH on that path return a
// CountedInputResponse envelope ({ items: [...] }).
import { ApiError, apiRequest } from './client';
import { type Counted, type EventBreakerRuleset, type StreamInput } from './types';

const PAGE_SIZE = 200;

/** Platform proxy rate limit is 100 requests/minute per app; retry 429s a few times. */
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 1_000;

/** Build a worker-group-context path (/m/:gid/...). */
function group(gid: string, path = ''): string {
  return `/m/${encodeURIComponent(gid)}${path}`;
}

/** Paginate an offset/limit collection endpoint into a single array. */
async function listAll<T>(path: string, signal?: AbortSignal): Promise<T[]> {
  const all: T[] = [];
  let offset = 0;
  // Guard against a runaway loop while still handling large groups.
  for (let page = 0; page < 500; page++) {
    const res = await apiRequest<Counted<T>>(path, {
      query: { offset, limit: PAGE_SIZE },
      signal,
    });
    const items = res.items ?? [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Run an API call, retrying only on 429 (rate limited) with linear backoff. A bulk run
 * issues two requests per Source, so a large selection can brush the platform's
 * 100 req/min proxy limit; everything else fails fast so real errors stay visible.
 */
async function withRateLimitRetry<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      const rateLimited = err instanceof ApiError && err.status === 429;
      if (!rateLimited || attempt >= MAX_RETRIES) throw err;
      await sleep(BASE_RETRY_DELAY_MS * (attempt + 1));
    }
  }
}

/**
 * List the Event Breaker rulesets available in a worker group
 * (GET /m/:gid/lib/breakers). These are the valid values of a Source's breakerRulesets.
 */
export function listGroupBreakerRulesets(
  gid: string,
  signal?: AbortSignal,
): Promise<EventBreakerRuleset[]> {
  return listAll<EventBreakerRuleset>(group(gid, '/lib/breakers'), signal);
}

/**
 * Fetch one Source's full, current configuration
 * (GET /m/:gid/system/inputs/{id}, unwrapping the CountedInputResponse envelope).
 *
 * The bulk apply re-reads each Source immediately before writing it so the PATCH is
 * built from live config rather than a possibly stale list response.
 */
export async function getGroupSource(
  gid: string,
  id: string,
  signal?: AbortSignal,
): Promise<StreamInput> {
  const res = await withRateLimitRetry(() =>
    apiRequest<Counted<StreamInput>>(group(gid, `/system/inputs/${encodeURIComponent(id)}`), {
      signal,
    }),
  );
  const source = res?.items?.[0];
  if (!source) throw new ApiError(`Source “${id}” was not found in this worker group.`, 404);
  return source;
}

/**
 * PATCH a Source with a full object body (GET-modify-PATCH round trip).
 * The caller builds the body with buildSourceUpdateBody() so only the Event Breaker
 * fields differ and nothing else is reset.
 */
export async function updateGroupSource(
  gid: string,
  body: StreamInput,
  signal?: AbortSignal,
): Promise<void> {
  await withRateLimitRetry(() =>
    apiRequest(group(gid, `/system/inputs/${encodeURIComponent(body.id)}`), {
      method: 'PATCH',
      body,
      signal,
    }),
  );
}
