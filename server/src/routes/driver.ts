import { Router, Request, Response } from 'express';
import { User } from '../models';

const router = Router();

// Endpoint to toggle driver's online/offline status
router.put('/:id/status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { isOnline } = req.body;

    if (typeof isOnline !== 'boolean') {
      return res.status(400).json({ error: 'isOnline must be a boolean.' });
    }

    const user = await User.findByPk(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    if (user.role !== 'DRIVER') {
      return res.status(403).json({ error: 'Only drivers can update their status.' });
    }

    user.isOnline = isOnline;
    await user.save();

    res.json({ message: 'Status updated successfully.', isOnline: user.isOnline });
  } catch (error) {
    console.error('Update status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
