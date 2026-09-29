// Mirrors server/src/utils/validation.ts `normalizePhone` so the form can validate
// before submitting. The server re-validates, so this is only for fast feedback.
const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Converts Bangla digits (০-৯) to ASCII (0-9). */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/** Returns the local 11-digit form (01XXXXXXXXX) of a Bangladesh mobile number, or null. */
export function normalizePhone(raw: string): string | null {
  const local = toAsciiDigits(raw)
    .replace(/[\s\-().]/g, '')
    .replace(/^(\+?880)/, '0');
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}
