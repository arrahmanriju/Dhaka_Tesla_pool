import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { getJwtSecret } from '../config/jwtSecret';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: 'DRIVER' | 'PASSENGER';
    name: string;
    phone?: string | null;
    email?: string | null;
  };
}

/**
 * Express middleware that validates a Bearer JWT in the Authorization header.
 * Attaches the decoded payload to `req.user` on success.
 */
export function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : null;

  if (!token) {
    res.status(401).json({ error: 'Authorization token required.' });
    return;
  }

  try {
    const decoded = jwt.verify(token, getJwtSecret()) as {
      id: string;
      role: 'DRIVER' | 'PASSENGER';
      name: string;
      phone?: string | null;
      email?: string | null;
    };
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token.' });
  }
}
