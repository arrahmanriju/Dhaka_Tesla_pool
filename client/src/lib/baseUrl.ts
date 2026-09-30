/**
 * The address of the API, from NEXT_PUBLIC_API_URL, without any trailing slash. Every request is built as
 * `${base}${path}` with a path that starts with "/", so a value like "https://api.example.com/" would
 * otherwise make "https://api.example.com//auth/signup", which the API answers with 404.
 * Spaces around the value are ignored too. Unset or blank means the local API.
 */
export function apiBaseUrl(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '');
  return value === '' ? 'http://localhost:3001' : value;
}
