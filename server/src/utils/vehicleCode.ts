import { randomInt } from 'crypto';

// ---------------------------------------------------------------------------
// The public vehicle code: printed on the QR sticker inside the car (the QR's content is exactly this
// code) and typed by hand by a passenger who cannot scan. No driver login is needed to use it.
//
// ONE PUBLIC ID. For a vehicle whose driver has a Tesla ID (every onboarded driver: "DTP-0001", shown
// as "Tesla ID" all over the app) the vehicle code IS that Tesla ID, so the code a passenger sees on the
// card, on the sticker and in the app is the code the lookup accepts. Only a vehicle with no driver
// profile gets a random code:

// 6 characters from a 28-character alphabet without look-alikes (no 0/O, 1/I/L, 5/S or 8), e.g. "4KQ7M2".
// 28^6 is about 480 million codes; guessing one at random hits a real vehicle very rarely, and all a
// code lets a passenger do is join a street ride in that car (nothing about the driver is exposed).
// Input is forgiven: case, spaces and hyphens are ignored ("4kq 7m2" and "4KQ-7M2" both work).
// ---------------------------------------------------------------------------
export const VEHICLE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRTUVWXYZ234679';
export const VEHICLE_CODE_LENGTH = 6;

/** A random code (the caller checks it is not already taken). */
export function generateVehicleCode(): string {
  let code = '';
  for (let i = 0; i < VEHICLE_CODE_LENGTH; i++) code += VEHICLE_CODE_ALPHABET[randomInt(VEHICLE_CODE_ALPHABET.length)];
  return code;
}

/**
 * What a stored code must look like: letters and digits, with single hyphens allowed between groups,
 * 4 to 16 characters. The Tesla ID "DTP-0001" is one (see below); generated codes have no hyphen.
 */
export const VEHICLE_CODE_PATTERN = /^(?=.{4,16}$)[A-Z0-9]+(-[A-Z0-9]+)*$/;

/**
 * Turns what a passenger typed or scanned into the canonical form, or null if it cannot be a code.
 * Case, spaces and underscores are ignored; a hyphen is kept ("dtp-0001" -> "DTP-0001").
 */
export function normalizeVehicleCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s_]/g, '');
  return VEHICLE_CODE_PATTERN.test(code) ? code : null;
}

/**
 * The form codes are compared in: the canonical code without hyphens. "DTP-0001" and "DTP0001" are the
 * same vehicle, so a passenger who types a Tesla ID without its hyphen still finds it.
 */
export const compactVehicleCode = (code: string): string => code.replace(/-/g, '');
