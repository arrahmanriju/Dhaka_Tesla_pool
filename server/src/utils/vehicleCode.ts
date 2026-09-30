import { randomInt } from 'crypto';

// ---------------------------------------------------------------------------
// The public vehicle code: printed on the QR sticker inside the car (the QR's content is exactly this
// code) and typed by hand by a passenger who cannot scan. No driver login is needed to use it.
//
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

/** What a stored code must look like. (Hand-chosen codes such as the seed's "BULLET" are allowed too.) */
export const VEHICLE_CODE_PATTERN = /^[A-Z0-9]{4,12}$/;

/** Turns what a passenger typed or scanned into the stored form, or null if it cannot be a code. */
export function normalizeVehicleCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s\-_]/g, '');
  return VEHICLE_CODE_PATTERN.test(code) ? code : null;
}
