import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwtSecret';

/** The secret the server signs with: the throwaway test value set in setupEnv.ts (there is no built-in default). */
const JWT_SECRET = getJwtSecret();

/** Authorization header for a logged-in user, for endpoints that identify the caller by token. */
export function asUser(userId: string, role: 'PASSENGER' | 'DRIVER' = 'PASSENGER') {
  const token = jwt.sign({ id: userId, role, name: 'Test User' }, JWT_SECRET, { expiresIn: '1h' });
  return { Authorization: `Bearer ${token}` };
}
