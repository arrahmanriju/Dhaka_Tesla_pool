import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '../models';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-mvp-key'; // Normally in .env

router.post('/signup', async (req: Request, res: Response) => {
  try {
    const { name, password, role } = req.body;

    if (!name || !password || !role) {
      return res.status(400).json({ error: 'Name, password, and role are required.' });
    }

    if (role !== 'DRIVER' && role !== 'PASSENGER') {
      return res.status(400).json({ error: 'Role must be DRIVER or PASSENGER.' });
    }

    const existingUser = await User.findOne({ where: { name } });
    if (existingUser) {
      return res.status(409).json({ error: 'User with this name already exists.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      name,
      password: hashedPassword,
      role,
      isOnline: role === 'DRIVER' ? false : undefined,
    });

    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    
    res.status(201).json({ token, user: { id: user.id, name: user.name, role: user.role, isOnline: user.isOnline } });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/login', async (req: Request, res: Response) => {
  try {
    const { name, password } = req.body;

    if (!name || !password) {
      return res.status(400).json({ error: 'Name and password are required.' });
    }

    const user = await User.findOne({ where: { name } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({ token, user: { id: user.id, name: user.name, role: user.role, isOnline: user.isOnline } });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
