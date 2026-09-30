import jwt from 'jsonwebtoken';

/** Same secret the auth middleware falls back to when JWT_SECRET is not set. */
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-mvp-key';

/** Authorization header for a logged-in user, for endpoints that identify the caller by token. */
export function asUser(userId: string, role: 'PASSENGER' | 'DRIVER' = 'PASSENGER') {
  const token = jwt.sign({ id: userId, role, name: 'Test User' }, JWT_SECRET, { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}
