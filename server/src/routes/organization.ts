import { Router } from 'express';
import { organizationController } from '../controllers/organization.js';
import { authenticate, requireRole } from '../middleware/auth.js';

export const organizationRouter = Router();

organizationRouter.use(authenticate);

organizationRouter.get('/', organizationController.get);
organizationRouter.patch('/', requireRole(['admin']), organizationController.update);
