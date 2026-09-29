import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-mvp-key';

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    role: 'DRIVER' | 'PASSENGER';
    name: string;
    email: string;
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
    const decoded = jwt.verify(token, JWT_SECRET) as {
      id: string;
      role: 'DRIVER' | 'PASSENGER';
      name: string;
      email: string;
    };
    req.user = decoded;
    next();
  } catch {
    res.status(403).json({ error: 'Invalid or expired token.' });
  }
}
