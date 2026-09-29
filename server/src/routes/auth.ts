import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { User, PasswordReset } from '../models';
import { isValidEmail, isValidPassword, isValidName, normalizePhone, toAsciiDigits } from '../utils/validation';
import { sendSms } from '../utils/sms';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-mvp-key';
const BCRYPT_ROUNDS = 10;

// Password reset
const RESET_CODE_TTL_MS = 10 * 60 * 1000; // a code is valid for 10 minutes
const RESET_RESEND_COOLDOWN_MS = 60 * 1000; // at most one new code per minute per account
const RESET_MAX_ATTEMPTS = 5; // wrong guesses before the code is burned
// Until an SMS gateway is wired into utils/sms.ts, non-production servers return the
// code in the API response so the flow can be tried. Never enabled in production
// unless RESET_CODE_IN_RESPONSE=true is set explicitly.
const EXPOSE_RESET_CODE =
  process.env.NODE_ENV !== 'production' || process.env.RESET_CODE_IN_RESPONSE === 'true';

const hashResetCode = (code: string) =>
  crypto.createHmac('sha256', JWT_SECRET).update(code).digest('hex');

const publicUser = (user: User) => ({
  id: user.id,
  name: user.name,
  phone: user.phone,
  email: user.email,
  role: user.role,
  isOnline: user.isOnline,
});

/**
 * POST /auth/signup
 * Body: { name, phone, email?, password, role }
 * `phone` (Bangladesh mobile) is required; `email` is optional.
 * Creates a new PASSENGER (or DRIVER) account, returns a signed JWT.
 */
router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { name, phone, email, password, role } = req.body;

    // --- Presence check (email is optional) ---
    if (!name || !phone || !password || !role) {
      return res.status(400).json({
        error: 'name, phone, password, and role are required.',
      });
    }

    // --- Field-level validation ---
    const nameError = isValidName(String(name));
    if (nameError) return res.status(400).json({ error: nameError });

    const normalizedPhone = normalizePhone(String(phone));
    if (!normalizedPhone) {
      return res.status(400).json({
        error: 'Invalid phone number. Use a Bangladesh mobile number like 01712345678.',
      });
    }

    const emailInput = typeof email === 'string' ? email.trim().toLowerCase() : '';
    if (emailInput && !isValidEmail(emailInput)) {
      return res.status(400).json({ error: 'Invalid email address.' });
    }

    const passwordError = isValidPassword(String(password));
    if (passwordError) return res.status(400).json({ error: passwordError });

    if (role !== 'DRIVER' && role !== 'PASSENGER') {
      return res.status(400).json({ error: 'role must be DRIVER or PASSENGER.' });
    }

    // --- Uniqueness check ---
    if (await User.findOne({ where: { phone: normalizedPhone } })) {
      return res.status(409).json({ error: 'An account with this phone number already exists.' });
    }
    if (emailInput && (await User.findOne({ where: { email: emailInput } }))) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    // --- Persist ---
    const hashedPassword = await bcrypt.hash(String(password), BCRYPT_ROUNDS);
    const user = await User.create({
      name: String(name).trim(),
      phone: normalizedPhone,
      email: emailInput || null,
      password: hashedPassword,
      role,
      isOnline: role === 'DRIVER' ? false : undefined,
    });

    // --- Issue token ---
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, phone: user.phone, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.status(201).json({
      token,
      user: publicUser(user),
    });
  } catch (error) {
    // Two signups racing past the checks above still hit the UNIQUE constraints.
    if ((error as { name?: string }).name === 'SequelizeUniqueConstraintError') {
      return res.status(409).json({ error: 'An account with this phone number or email already exists.' });
    }
    console.error('[signup] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /auth/login
 * Body: { phone, password }  (accounts created before phone numbers existed can
 * still sign in with { email, password })
 * Returns a signed JWT on success; generic 401 on bad credentials (no user enumeration).
 */
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { phone, email, password } = req.body;

    // --- Presence check ---
    if ((!phone && !email) || !password) {
      return res.status(400).json({ error: 'phone and password are required.' });
    }

    let where: { phone: string } | { email: string };
    if (phone) {
      const normalizedPhone = normalizePhone(String(phone));
      if (!normalizedPhone) {
        return res.status(400).json({
          error: 'Invalid phone number. Use a Bangladesh mobile number like 01712345678.',
        });
      }
      where = { phone: normalizedPhone };
    } else {
      if (!isValidEmail(String(email))) {
        return res.status(400).json({ error: 'Invalid email address.' });
      }
      where = { email: String(email).trim().toLowerCase() };
    }

    // --- Lookup & verify (constant-time compare prevents timing attacks) ---
    const user = await User.findOne({ where });
    const DUMMY_HASH = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
    const isMatch = user
      ? await bcrypt.compare(String(password), user.password)
      : await bcrypt.compare(String(password), DUMMY_HASH); // prevent user enumeration

    if (!user || !isMatch) {
      return res.status(401).json({ error: 'Invalid phone number or password.' });
    }

    // --- Issue token ---
    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name, phone: user.phone, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    return res.json({
      token,
      user: publicUser(user),
    });
  } catch (error) {
    console.error('[login] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /auth/forgot-password
 * Body: { phone }
 * Sends a 6-digit reset code by SMS. Always answers 200 for a well-formed number,
 * whether or not an account exists, so it cannot be used to discover accounts.
 */
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'phone is required.' });

    const normalizedPhone = normalizePhone(String(phone));
    if (!normalizedPhone) {
      return res.status(400).json({
        error: 'Invalid phone number. Use a Bangladesh mobile number like 01712345678.',
      });
    }

    let devCode: string | undefined;
    const user = await User.findOne({ where: { phone: normalizedPhone } });
    if (user) {
      const latest = await PasswordReset.findOne({ where: { userId: user.id }, order: [['createdAt', 'DESC']] });
      const coolingDown = latest && Date.now() - latest.createdAt.getTime() < RESET_RESEND_COOLDOWN_MS;
      if (!coolingDown) {
        const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
        await PasswordReset.destroy({ where: { userId: user.id } }); // only the newest code works
        await PasswordReset.create({
          userId: user.id,
          codeHash: hashResetCode(code),
          expiresAt: new Date(Date.now() + RESET_CODE_TTL_MS),
        });
        await sendSms(
          normalizedPhone,
          `Tesla Pool Dhaka: your password reset code is ${code}. It expires in 10 minutes.`
        );
        if (EXPOSE_RESET_CODE) devCode = code;
      }
    }

    return res.json({
      message: 'If an account exists for this number, a reset code has been sent.',
      expiresInMinutes: RESET_CODE_TTL_MS / 60000,
      ...(devCode ? { devCode } : {}),
    });
  } catch (error) {
    console.error('[forgot-password] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * POST /auth/reset-password
 * Body: { phone, code, newPassword }
 * Sets a new password if `code` is the current, unexpired code sent to `phone`.
 * Every failure to match returns the same generic 400 (no hints about which part was wrong).
 */
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { phone, code, newPassword } = req.body;
    if (!phone || !code || !newPassword) {
      return res.status(400).json({ error: 'phone, code, and newPassword are required.' });
    }

    // Checked first so a weak password doesn't burn a guess or the code.
    const passwordError = isValidPassword(String(newPassword));
    if (passwordError) return res.status(400).json({ error: passwordError });

    const INVALID = { error: 'Invalid or expired code.' };
    const normalizedPhone = normalizePhone(String(phone));
    if (!normalizedPhone) return res.status(400).json(INVALID);

    const user = await User.findOne({ where: { phone: normalizedPhone } });
    const reset = user
      ? await PasswordReset.findOne({ where: { userId: user.id }, order: [['createdAt', 'DESC']] })
      : null;
    if (!user || !reset) return res.status(400).json(INVALID);

    if (reset.expiresAt.getTime() < Date.now() || reset.attempts >= RESET_MAX_ATTEMPTS) {
      await reset.destroy();
      return res.status(400).json(INVALID);
    }

    const given = Buffer.from(hashResetCode(toAsciiDigits(String(code)).trim()));
    const expected = Buffer.from(reset.codeHash);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      await reset.increment('attempts');
      return res.status(400).json(INVALID);
    }

    user.password = await bcrypt.hash(String(newPassword), BCRYPT_ROUNDS);
    await user.save();
    await PasswordReset.destroy({ where: { userId: user.id } }); // single use

    return res.json({ message: 'Password updated. You can now sign in.' });
  } catch (error) {
    console.error('[reset-password] error:', error);
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
      attributes: ['id', 'name', 'phone', 'email', 'role', 'createdAt'],
    });
    if (!user) return res.status(404).json({ error: 'User not found.' });
    return res.json({ user });
  } catch (error) {
    console.error('[me] error:', error);
    return res.status(500).json({ error: 'Internal server error.' });
  }
});

export default router;
