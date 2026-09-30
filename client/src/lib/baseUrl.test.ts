/** The API address is used as a prefix, so a trailing slash must never turn a path into "//auth/signup". Run with `npm test`. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiBaseUrl } from './baseUrl';

test('a trailing slash is removed, so a request path does not start with two slashes', () => {
  assert.equal(apiBaseUrl('https://api.up.railway.app/'), 'https://api.up.railway.app');
  assert.equal(`${apiBaseUrl('https://api.up.railway.app/')}/auth/signup`, 'https://api.up.railway.app/auth/signup');
  assert.equal(apiBaseUrl('https://api.up.railway.app///'), 'https://api.up.railway.app');
});

test('an address without a slash is unchanged, and spaces are ignored', () => {
  assert.equal(apiBaseUrl('https://api.up.railway.app'), 'https://api.up.railway.app');
  assert.equal(apiBaseUrl('  https://api.up.railway.app/  '), 'https://api.up.railway.app');
  assert.equal(apiBaseUrl('http://localhost:3001/'), 'http://localhost:3001');
});

test('unset or blank means the local API', () => {
  assert.equal(apiBaseUrl(undefined), 'http://localhost:3001');
  assert.equal(apiBaseUrl(''), 'http://localhost:3001');
  assert.equal(apiBaseUrl('   '), 'http://localhost:3001');
});
