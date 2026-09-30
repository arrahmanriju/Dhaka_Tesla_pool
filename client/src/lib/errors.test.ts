/**
 * The error messages people see. Run with `npm test` (Node's built-in test runner through tsx).
 *
 * Rule under test: a failed request is always explained in plain words. No status code ("HTTP 404",
 * "Error 404: ..."), no browser jargon ("Failed to fetch"), never a blank message; but a real reason from
 * the server ("Not enough seats available.") is kept, because that is the most useful thing to show.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, passengerApi } from './api';
import { describeError } from './errors';
import { DICTIONARIES, type Lang, type TranslationKey } from './translations';

const tFor = (lang: Lang) => (key: TranslationKey) => DICTIONARIES[lang][key];
const en = tFor('en');

test('no connection: a failed fetch and an ApiError(0) both say the server cannot be reached', () => {
  const expected = en('err.network');
  assert.equal(describeError(new TypeError('Failed to fetch'), en), expected);
  assert.equal(describeError(new ApiError(0, 'Network error', 'NETWORK'), en), expected);
});

test('a missing message is replaced by a sentence for the status, not "HTTP 404"', () => {
  assert.equal(describeError(new ApiError(404, 'HTTP 404'), en), en('err.notFound'));
  assert.equal(describeError(new ApiError(403, 'HTTP 403'), en), en('err.forbidden'));
  assert.equal(describeError(new ApiError(401, 'HTTP 401'), en), en('err.session'));
  assert.equal(describeError(new ApiError(409, 'HTTP 409'), en), en('err.conflict'));
  assert.equal(describeError(new ApiError(429, 'HTTP 429'), en), en('err.busy'));
  assert.equal(describeError(new ApiError(400, 'HTTP 400'), en), en('err.generic'));
  assert.equal(describeError(new ApiError(404, ''), en), en('err.notFound'));
});

test('a server fault is never shown raw, even when the server sent text', () => {
  const expected = en('err.server');
  assert.equal(describeError(new ApiError(500, 'Internal server error'), en), expected);
  assert.equal(describeError(new ApiError(502, 'HTTP 502'), en), expected);
  assert.equal(describeError(new ApiError(503, 'SQLITE_BUSY: database is locked'), en), expected);
});

test('a real reason from the server is kept', () => {
  assert.equal(describeError(new ApiError(409, 'Not enough seats available.'), en), 'Not enough seats available.');
  assert.equal(describeError(new ApiError(401, 'Invalid credentials'), en), 'Invalid credentials'); // wrong password, not an expired session
  assert.equal(describeError(new ApiError(404, 'Ride not found.'), en), 'Ride not found.');
});

test('anything else falls back to a generic sentence, in both languages', () => {
  for (const lang of ['en', 'bn'] as const) {
    const t = tFor(lang);
    for (const thrown of ['boom', null, undefined, 42, new Error('oops')]) {
      assert.equal(describeError(thrown, t), t('err.generic'));
    }
  }
});

test('no message ever contains a status code or browser jargon, in either language', () => {
  const statuses = [0, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503];
  for (const lang of ['en', 'bn'] as const) {
    const t = tFor(lang);
    for (const status of statuses) {
      const message = describeError(new ApiError(status, `HTTP ${status}`), t);
      assert.ok(message.trim().length > 10, `status ${status} gave an empty message`);
      assert.doesNotMatch(message, /HTTP|\b[45]\d\d\b|Failed to fetch|TypeError|undefined|null/);
    }
  }
});

// The API client turns real network and HTTP failures into those errors. Tested with a stubbed fetch.
async function withFetch<T>(fake: typeof fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('api client: a network failure becomes a friendly "cannot reach the server"', async () => {
  const error = await withFetch(
    (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch,
    () => passengerApi.getWallet().then(() => null, (e) => e),
  );
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 0);
  assert.equal(describeError(error, en), en('err.network'));
});

test('api client: an HTML 404 page (no JSON) is shown as "not found", not "HTTP 404"', async () => {
  const html = (async () => new Response('<!DOCTYPE html><h1>Not found</h1>', { status: 404, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const error = await withFetch(html, () => passengerApi.getWallet().then(() => null, (e) => e));
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 404);
  assert.equal(describeError(error, en), en('err.notFound'));
});

test('api client: the server\'s own JSON message comes through', async () => {
  const json = (async () => new Response(JSON.stringify({ error: 'Not enough seats available.' }), { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const error = await withFetch(json, () => passengerApi.getWallet().then(() => null, (e) => e));
  assert.equal(describeError(error, en), 'Not enough seats available.');
});

test('api client: a 500 with a JSON body is still a friendly server-fault message', async () => {
  const boom = (async () => new Response(JSON.stringify({ error: 'Internal server error' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  const error = await withFetch(boom, () => passengerApi.getWallet().then(() => null, (e) => e));
  assert.equal(describeError(error, en), en('err.server'));
});
