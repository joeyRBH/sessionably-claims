import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { db } from '../database/index.js';
import { payers } from '../models/schema.js';
import { eq, and } from 'drizzle-orm';

const payerSchema = z.object({
  name: z.string().min(1),
  portalUrl: z.string().url(),
  timelyFilingDays: z.number().min(1),
  color: z.string().default('#3B82F6'),
  payerId: z.string().optional(),
  isActive: z.boolean().default(true),
});

const updatePayerSchema = payerSchema.partial();

export const payersController = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const result = await db
      .select()
      .from(payers)
      .where(eq(payers.organizationId, req.user!.organizationId));

    res.json(result);
  }),

  get: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const [payer] = await db
      .select()
      .from(payers)
      .where(
        and(
          eq(payers.id, id),
          eq(payers.organizationId, req.user!.organizationId)
        )
      )
      .limit(1);

    if (!payer) {
      throw new AppError('Payer not found', 404);
    }

    res.json(payer);
  }),

  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = payerSchema.parse(req.body);

    const [payer] = await db
      .insert(payers)
      .values({
        ...data,
        organizationId: req.user!.organizationId,
      })
      .returning();

    res.status(201).json(payer);
  }),

  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const data = updatePayerSchema.parse(req.body);

    const [existing] = await db
      .select()
      .from(payers)
      .where(
        and(
          eq(payers.id, id),
          eq(payers.organizationId, req.user!.organizationId)
        )
      )
      .limit(1);

    if (!existing) {
      throw new AppError('Payer not found', 404);
    }

    const [payer] = await db
      .update(payers)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(payers.id, id))
      .returning();

    res.json(payer);
  }),

  delete: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const [existing] = await db
      .select()
      .from(payers)
      .where(
        and(
          eq(payers.id, id),
          eq(payers.organizationId, req.user!.organizationId)
        )
      )
      .limit(1);

    if (!existing) {
      throw new AppError('Payer not found', 404);
    }

    await db.delete(payers).where(eq(payers.id, id));

    res.status(204).send();
  }),
};
