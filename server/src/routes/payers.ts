import { Router } from 'express';
import { payersController } from '../controllers/payers.js';
import { authenticate } from '../middleware/auth.js';

export const payersRouter = Router();

payersRouter.use(authenticate);

payersRouter.get('/', payersController.list);
payersRouter.get('/:id', payersController.get);
payersRouter.post('/', payersController.create);
payersRouter.patch('/:id', payersController.update);
payersRouter.delete('/:id', payersController.delete);
