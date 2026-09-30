import { ApiError } from './api';
import type { TranslationKey } from './translations';

type T = (key: TranslationKey, vars?: Record<string, string | number>) => string;

/** api.ts builds this message when the server sent no error text of its own. */
const FALLBACK_MESSAGE = /^HTTP \d+$/;

/**
 * Turns anything thrown while talking to the server into a sentence a passenger or driver can act on.
 * A status code or a raw fetch failure ("Failed to fetch", "HTTP 404") is never shown.
 *
 *   - no connection                         -> "Can't reach the server..."
 *   - 5xx                                   -> "Something went wrong on our side..."
 *   - the server gave a real reason         -> that reason ("Not enough seats available.", "Invalid credentials")
 *   - no reason, so by status               -> not signed in / not allowed / not found / busy / conflict / generic
 */
export function describeError(err: unknown, t: T): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return t('err.network');
    if (err.status >= 500) return t('err.server');
    const text = err.message?.trim();
    if (text && !FALLBACK_MESSAGE.test(text)) return text;
    switch (err.status) {
      case 401: return t('err.session');
      case 403: return t('err.forbidden');
      case 404: return t('err.notFound');
      case 409: return t('err.conflict');
      case 429: return t('err.busy');
      default: return t('err.generic');
    }
  }
  // fetch() itself failed (offline, server down, blocked): the browser throws a TypeError
  if (err instanceof TypeError) return t('err.network');
  return t('err.generic');
}
