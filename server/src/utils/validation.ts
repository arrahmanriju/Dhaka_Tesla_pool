/**
 * Lightweight input-validation helpers used by auth routes.
 */

export function isValidEmail(email: string): boolean {
  // RFC 5322 simplified — good enough for an MVP
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

const BANGLA_DIGITS = '০১২৩৪৫৬৭৮৯';

/** Converts Bangla digits (০-৯) to ASCII (0-9). */
export function toAsciiDigits(input: string): string {
  return input.replace(/[০-৯]/g, (d) => String(BANGLA_DIGITS.indexOf(d)));
}

/**
 * Normalises a Bangladesh mobile number to its local 11-digit form (01XXXXXXXXX).
 * Accepts Bangla digits, spaces/dashes/parentheses, and the +880 / 880 / 0 prefixes.
 * Returns null if the input is not a valid BD mobile number (01[3-9] + 8 digits).
 */
export function normalizePhone(raw: string): string | null {
  const ascii = toAsciiDigits(String(raw))
    .replace(/[\s\-().]/g, '');
  const local = ascii.replace(/^(\+?880)/, '0');
  return /^01[3-9]\d{8}$/.test(local) ? local : null;
}

export function isValidPassword(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(password)) return 'Password must contain at least one letter.';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number.';
  return null; // valid
}

export function isValidName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < 2) return 'Name must be at least 2 characters.';
  if (trimmed.length > 60) return 'Name must be 60 characters or fewer.';
  return null; // valid
}
