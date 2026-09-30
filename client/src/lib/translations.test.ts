/**
 * The translation tables. Run with `npm test`.
 * A missing Bangla string, a mangled {placeholder} or a leftover raw status message would only show up
 * on a screen in the other language, so they are checked here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTIONARIES } from './translations';

const en = DICTIONARIES.en as Record<string, string>;
const bn = DICTIONARIES.bn as Record<string, string>;
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

test('English and Bangla have exactly the same keys', () => {
  const onlyEn = Object.keys(en).filter((k) => !(k in bn));
  const onlyBn = Object.keys(bn).filter((k) => !(k in en));
  assert.deepEqual(onlyEn, [], `missing in Bangla: ${onlyEn.join(', ')}`);
  assert.deepEqual(onlyBn, [], `missing in English: ${onlyBn.join(', ')}`);
});

test('every string is non-empty and uses the same {placeholders} in both languages', () => {
  for (const key of Object.keys(en)) {
    assert.ok(en[key]!.trim().length > 0, `${key} is empty in English`);
    assert.ok(bn[key]!.trim().length > 0, `${key} is empty in Bangla`);
    assert.deepEqual(placeholders(bn[key]!), placeholders(en[key]!), `${key}: placeholders differ between languages`);
  }
});

test('plural strings come in complete _one / _other pairs', () => {
  for (const dict of [en, bn]) {
    for (const key of Object.keys(dict)) {
      if (key.endsWith('_one')) assert.ok(`${key.slice(0, -4)}_other` in dict, `${key} has no _other`);
      if (key.endsWith('_other')) assert.ok(`${key.slice(0, -6)}_one` in dict, `${key} has no _one`);
    }
  }
});

test('the error, loading and empty states all have text', () => {
  const required = [
    // errors
    'err.network', 'err.server', 'err.session', 'err.forbidden', 'err.notFound', 'err.conflict', 'err.busy', 'err.generic',
    'err.retry', 'err.loadTitle', 'rs.gone',
    // loading
    'loading.default', 'loading.passenger', 'loading.driver', 'loading.rides', 'loading.history', 'loading.pending',
    'loading.activeRides', 'loading.vehicle', 'loading.trips', 'loading.zones',
    // empty
    'p.active.emptyTitle', 'p.active.emptyDesc', 'p.history.emptyTitle', 'p.history.emptyDesc',
    'd.pending.emptyTitle', 'd.pending.emptyDesc', 'd.active.emptyTitle', 'd.active.emptyDesc',
    'd.history.emptyTitle', 'd.history.emptyDesc', 'd.vehicle.noneTitle', 'd.vehicle.noneDesc',
    'd.pending.noVehicleTitle', 'd.pending.noVehicleDesc', 'd.offers.none',
  ];
  for (const key of required) {
    assert.ok(en[key], `English text for ${key}`);
    assert.ok(bn[key], `Bangla text for ${key}`);
  }
});

test('no user-facing error text shows a status code or "HTTP"', () => {
  for (const dict of [en, bn]) {
    for (const key of Object.keys(dict).filter((k) => k.startsWith('err.'))) {
      assert.doesNotMatch(dict[key]!, /HTTP|\{status\}|\b[45]\d\d\b/, `${key} mentions a status code`);
    }
  }
});
