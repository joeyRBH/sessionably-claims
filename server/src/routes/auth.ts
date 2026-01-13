import { Router } from 'express';
import { authController } from '../controllers/auth.js';
import { authenticate } from '../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/login', authController.login);
authRouter.post('/register', authController.register);
authRouter.get('/me', authenticate, authController.me);
authRouter.post('/change-password', authenticate, authController.changePassword);
