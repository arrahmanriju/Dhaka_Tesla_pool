import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models';
import { isValidEmail, isValidPassword, isValidName } from '../utils/validation';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-mvp-key';
const BCRYPT_ROUNDS = 10;

/**
 * POST /auth/signup
 * Body: { name, email, password, role }
 * Creates a new PASSENGER (or DRIVER) account, returns a signed JWT.
 */
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body;

    // --- Presence check ---
    if (!name || !email || !password || !role) {
      return res.status(400).json({
        error: 'name, email, password, and role are all required.',
      });
    }

    // --- Field-level validation ---
    const nameError = isValidName(String(name));
    if (nameError) return res.status(400).json({ error: nameError });

    if (!isValidEmail(String(email))) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const passwordError = isValidPassword(String(password));
    if (passwordError) return res.status(400).json({ error: passwordError });

    if (role !== 'DRIVER' && role !== 'PASSENGER') {
      return res.status(400).json({ error: 'role must be DRIVER or PASSENGER.' });
    }

    // --- Uniqueness check ---
    const existing = await User.findOne({ where: { email: String(email).toLowerCase() } });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // --- Persist ---
    const hashedPassword = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const user = await User.create({
      name: String(name).trim(),
      email: String(email).toLowerCase().trim(),
      password: hashedPassword,
      role,
    });

    // --- Issue token ---
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    console.error('[signup] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /auth/login
 * Body: { email, password }
 * Returns a signed JWT on success; generic 401 on bad credentials (no user enumeration).
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    // --- Presence check ---
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required.' });
    }

    if (!isValidEmail(String(email))) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    // --- Lookup & verify (constant-time compare prevents timing attacks) ---
    const user = await User.findOne({ where: { email: String(email).toLowerCase() } });
    const DUMMY_HASH = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const isMatch = user
      ? await bcrypt.compare(String(password), user.password)
      : await bcrypt.compare(String(password), DUMMY_HASH); // prevent user enumeration

    if (!user || !isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    // --- Issue token ---
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      token,
      user: { id: user.id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error) {
    console.error('[login] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /auth/me
 * Requires: Authorization: Bearer <token>
 * Returns the current authenticated user's profile.
 */
router.get('/me', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = await User.findByPk(req.user!.id, {
      attributes: ['id', 'name', 'email', 'role', 'createdAt'],
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ user });
  } catch (error) {
    console.error('[me] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
