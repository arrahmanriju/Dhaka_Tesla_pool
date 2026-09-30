// Loads server/.env (if there is one) before anything reads the secret, whatever order modules are imported in.
import 'dotenv/config';

/**
 * The secret that signs every login token (JWT) and the password-reset code hashes (HMAC).
 *
 * There is NO default. A default would be a public, committed value, and anyone who knew it could forge a login
 * token for any account. If JWT_SECRET is missing (or is a known-weak value, or too short) the server refuses
 * to start and says exactly how to fix it.
 */
export const MIN_JWT_SECRET_LENGTH = 32;

/** Values that were once the built-in default. They are public, so they are refused even if someone sets them. */
export const KNOWN_INSECURE_SECRETS: readonly string[] = ['super-secret-mvp-key'];

const HOW_TO_FIX =
  'Generate one with:\n' +
  '    openssl rand -base64 32\n' +
  '  (or, with Node:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))")\n' +
  'then set it as the JWT_SECRET environment variable: in server/.env for local use, in a .env file next to\n' +
  'docker-compose.yml (or exported in your shell) for Docker, or in your hosting platform\'s environment settings.';

export class JwtSecretError extends Error {
  constructor(problem: string) {
    super(`JWT_SECRET ${problem}. The server will not start without a strong secret: it signs every login token and password-reset code.\n${HOW_TO_FIX}`);
    this.name = 'JwtSecretError';
  }
}

/** Returns the secret, or throws JwtSecretError explaining what is wrong with it. */
export function requireJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  const secret = env.JWT_SECRET;
  if (secret === undefined || secret.trim() === '') throw new JwtSecretError('is not set');
  if (KNOWN_INSECURE_SECRETS.includes(secret)) throw new JwtSecretError('is set to a public, known value');
  if (secret.length < MIN_JWT_SECRET_LENGTH) throw new JwtSecretError(`is too short (${secret.length} characters; at least ${MIN_JWT_SECRET_LENGTH} are required)`);
  return secret;
}

/** The secret for signing and verifying. Read at the moment of use, so a missing secret can never be silently replaced. */
export const getJwtSecret = (): string => requireJwtSecret();
