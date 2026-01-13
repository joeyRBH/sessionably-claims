import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { db } from '../database/index.js';
import { organizations } from '../models/schema.js';
import { eq } from 'drizzle-orm';

const updateOrganizationSchema = z.object({
  name: z.string().min(1).optional(),
  npi: z.string().length(10).optional(),
  taxId: z.string().length(9).optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().max(2).optional(),
  zipCode: z.string().optional(),
  phone: z.string().optional(),
});

export const organizationController = {
  get: asyncHandler(async (req: AuthRequest, res: Response) => {
    const [organization] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.user!.organizationId))
      .limit(1);

    if (!organization) {
      throw new AppError('Organization not found', 404);
    }

    res.json(organization);
  }),

  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = updateOrganizationSchema.parse(req.body);

    const [existing] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, req.user!.organizationId))
      .limit(1);

    if (!existing) {
      throw new AppError('Organization not found', 404);
    }

    const [organization] = await db
      .update(organizations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(organizations.id, req.user!.organizationId))
      .returning();

    res.json(organization);
  }),
};
