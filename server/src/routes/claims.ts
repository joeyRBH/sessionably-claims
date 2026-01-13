import { Router } from 'express';
import { claimsController } from '../controllers/claims.js';
import { authenticate } from '../middleware/auth.js';

export const claimsRouter = Router();

claimsRouter.use(authenticate);

claimsRouter.get('/', claimsController.list);
claimsRouter.get('/stats', claimsController.stats);
claimsRouter.get('/:id', claimsController.get);
claimsRouter.post('/', claimsController.create);
claimsRouter.patch('/:id', claimsController.update);
claimsRouter.delete('/:id', claimsController.delete);
