import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DHAKA_ZONES } from '../models/RideRequest';
import { toAsciiDigits } from './validation';

export const NID_LENGTHS = [10, 13, 17] as const;
export const MAX_SEATS = 3;
export const MAX_PICTURE_BYTES = 2 * 1024 * 1024; // 2 MB

export interface OnboardingInput {
  nickname: string;
  seatCapacity: number;
  homeZone: string;
  nid: string;
  picture: ParsedPicture | null;
}

export interface ParsedPicture {
  buffer: Buffer;
  ext: 'jpg' | 'png';
}

export type FieldErrors = Partial<Record<'nickname' | 'seatCapacity' | 'homeZone' | 'nid' | 'profilePicture', string>>;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/**
 * Validates the onboarding form body. Returns either the cleaned values or a map of
 * field -> message (all problems at once, so the form can flag every field).
 */
export function validateOnboarding(
  body: Record<string, unknown>
): { ok: true; value: OnboardingInput } | { ok: false; fields: FieldErrors } {
  const fields: FieldErrors = {};

  const nickname = typeof body.nickname === 'string' ? body.nickname.trim().replace(/\s+/g, ' ') : '';
  if (!nickname) fields.nickname = 'Vehicle nickname is required.';
  else if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} '\-_.]{1,29}$/u.test(nickname)) {
    fields.nickname = 'Nickname must be 2–30 characters (letters, numbers, spaces, - _ . \').';
  }

  const rawSeats = body.seatCapacity;
  const seatCapacity = typeof rawSeats === 'string' && rawSeats.trim() !== '' ? Number(rawSeats) : rawSeats;
  if (seatCapacity === undefined || seatCapacity === null || seatCapacity === '') {
    fields.seatCapacity = 'Seat capacity is required.';
  } else if (typeof seatCapacity !== 'number' || !Number.isInteger(seatCapacity) || seatCapacity < 1 || seatCapacity > MAX_SEATS) {
    fields.seatCapacity = `Seat capacity must be a whole number from 1 to ${MAX_SEATS}.`;
  }

  const homeZone = typeof body.homeZone === 'string' ? body.homeZone.trim() : '';
  if (!homeZone) fields.homeZone = 'Home zone is required.';
  else if (!(DHAKA_ZONES as readonly string[]).includes(homeZone)) {
    fields.homeZone = `Home zone must be one of: ${DHAKA_ZONES.join(', ')}.`;
  }

  const nid = typeof body.nid === 'string' || typeof body.nid === 'number' ? toAsciiDigits(String(body.nid).trim()) : '';
  if (!nid) fields.nid = 'NID number is required.';
  else if (!/^\d+$/.test(nid)) fields.nid = 'NID must contain digits only.';
  else if (!(NID_LENGTHS as readonly number[]).includes(nid.length)) {
    fields.nid = `NID must be ${NID_LENGTHS.join(', ')} digits long.`;
  }

  let picture: ParsedPicture | null = null;
  const rawPicture = body.profilePicture;
  if (rawPicture !== undefined && rawPicture !== null && rawPicture !== '') {
    const parsed = parsePicture(rawPicture);
    if (typeof parsed === 'string') fields.profilePicture = parsed;
    else picture = parsed;
  }

  if (Object.keys(fields).length > 0) return { ok: false, fields };
  return {
    ok: true,
    value: { nickname, seatCapacity: seatCapacity as number, homeZone, nid, picture },
  };
}

/** Parses a `data:image/(png|jpeg);base64,...` string. Returns an error message on failure. */
function parsePicture(raw: unknown): ParsedPicture | string {
  if (typeof raw !== 'string') return 'Profile picture must be a JPG or PNG image.';
  const match = /^data:(image\/png|image\/jpeg|image\/jpg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
  if (!match) return 'Profile picture must be a JPG or PNG image.';

  // Cheap size guard before decoding: 4 base64 chars carry 3 bytes.
  if (Math.ceil((match[2]!.length * 3) / 4) > MAX_PICTURE_BYTES + 3) return 'Profile picture must be 2 MB or smaller.';
  const buffer = Buffer.from(match[2]!, 'base64');
  if (buffer.length > MAX_PICTURE_BYTES) return 'Profile picture must be 2 MB or smaller.';

  // Trust the bytes, not the label the client put on them.
  const isPng = buffer.subarray(0, 8).equals(PNG_MAGIC);
  const isJpeg = buffer.subarray(0, 3).equals(JPEG_MAGIC);
  if (!isPng && !isJpeg) return 'Profile picture must be a JPG or PNG image.';
  if ((match[1] === 'image/png') !== isPng) return 'Profile picture must be a JPG or PNG image.';
  return { buffer, ext: isPng ? 'png' : 'jpg' };
}

/** "1234567890" -> "******7890". Only the last 4 digits are ever shown. */
export const maskNid = (nid: string) => '*'.repeat(Math.max(0, nid.length - 4)) + nid.slice(-4);

// ─── Profile picture storage ───────────────────────────────────────────────
// Files live next to the database (server/data/uploads), which is the Docker volume,
// so they survive container rebuilds. Names are random UUIDs; the original file name
// is never used.
export const UPLOADS_DIR = (dbPath: string) => path.join(path.dirname(path.resolve(dbPath)), 'uploads');

export function saveProfilePicture(uploadsDir: string, picture: ParsedPicture): string {
  fs.mkdirSync(uploadsDir, { recursive: true });
  const fileName = `${crypto.randomUUID()}.${picture.ext}`;
  fs.writeFileSync(path.join(uploadsDir, fileName), picture.buffer, { flag: 'wx' });
  return fileName;
}

export function deleteProfilePicture(uploadsDir: string, fileName: string | null | undefined): void {
  if (!fileName || fileName !== path.basename(fileName)) return; // never follow a path
  fs.rmSync(path.join(uploadsDir, fileName), { force: true });
}
