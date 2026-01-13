import { Response } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest } from '../middleware/auth.js';
import { db } from '../database/index.js';
import { claims, payers } from '../models/schema.js';
import { eq, and, desc, sql, ilike } from 'drizzle-orm';

const claimSchema = z.object({
  clientName: z.string().min(1),
  clientDob: z.string().optional(),
  memberId: z.string().optional(),
  serviceDate: z.string(),
  cptCode: z.string(),
  modifier1: z.string().optional(),
  modifier2: z.string().optional(),
  modifier3: z.string().optional(),
  modifier4: z.string().optional(),
  units: z.number().default(1),
  diagnosisCode: z.string(),
  payerId: z.string().uuid(),
  renderingProvider: z.string().optional(),
  npi: z.string().optional(),
  taxId: z.string().optional(),
  placeOfService: z.string().default('11'),
  chargeAmount: z.number().optional(),
  status: z.enum(['draft', 'ready', 'submitted', 'pending', 'paid', 'denied']).default('draft'),
  notes: z.string().optional(),
});

const updateClaimSchema = claimSchema.partial();

export const claimsController = {
  list: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { status, payer, search, limit = '50', offset = '0' } = req.query;

    let query = db
      .select()
      .from(claims)
      .where(eq(claims.organizationId, req.user!.organizationId))
      .orderBy(desc(claims.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    const conditions = [eq(claims.organizationId, req.user!.organizationId)];

    if (status) {
      conditions.push(eq(claims.status, status as string));
    }

    if (payer) {
      conditions.push(eq(claims.payerId, payer as string));
    }

    if (search) {
      conditions.push(ilike(claims.clientName, `%${search}%`));
    }

    const result = await db
      .select()
      .from(claims)
      .where(and(...conditions))
      .orderBy(desc(claims.createdAt))
      .limit(parseInt(limit as string))
      .offset(parseInt(offset as string));

    res.json({ claims: result });
  }),

  stats: asyncHandler(async (req: AuthRequest, res: Response) => {
    const orgId = req.user!.organizationId;

    // Get total and by status
    const statusCounts = await db
      .select({
        status: claims.status,
        count: sql<number>`count(*)::int`,
      })
      .from(claims)
      .where(eq(claims.organizationId, orgId))
      .groupBy(claims.status);

    // Get by payer
    const payerCounts = await db
      .select({
        payerId: claims.payerId,
        count: sql<number>`count(*)::int`,
      })
      .from(claims)
      .where(eq(claims.organizationId, orgId))
      .groupBy(claims.payerId);

    // Get urgent count (within 14 days of deadline)
    const urgentResult = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(claims)
      .innerJoin(payers, eq(claims.payerId, payers.id))
      .where(
        and(
          eq(claims.organizationId, orgId),
          sql`${claims.status} IN ('draft', 'ready')`,
          sql`${claims.serviceDate}::date + ${payers.timelyFilingDays} - CURRENT_DATE <= 14`
        )
      );

    const byStatus: Record<string, number> = {};
    let total = 0;
    statusCounts.forEach((row) => {
      byStatus[row.status] = row.count;
      total += row.count;
    });

    const byPayer: Record<string, number> = {};
    payerCounts.forEach((row) => {
      byPayer[row.payerId] = row.count;
    });

    res.json({
      total,
      byStatus,
      byPayer,
      urgent: urgentResult[0]?.count || 0,
    });
  }),

  get: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const [claim] = await db
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.id, id),
          eq(claims.organizationId, req.user!.organizationId)
        )
      )
      .limit(1);

    if (!claim) {
      throw new AppError('Claim not found', 404);
    }

    res.json(claim);
  }),

  create: asyncHandler(async (req: AuthRequest, res: Response) => {
    const data = claimSchema.parse(req.body);

    const [claim] = await db
      .insert(claims)
      .values({
        ...data,
        organizationId: req.user!.organizationId,
        createdBy: req.user!.id,
      })
      .returning();

    res.status(201).json(claim);
  }),

  update: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;
    const data = updateClaimSchema.parse(req.body);

    const [existing] = await db
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.id, id),
          eq(claims.organizationId, req.user!.organizationId)
        )
      )
      .limit(1);

    if (!existing) {
      throw new AppError('Claim not found', 404);
    }

    const [claim] = await db
      .update(claims)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(claims.id, id))
      .returning();

    res.json(claim);
  }),

  delete: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { id } = req.params;

    const [existing] = await db
      .select()
      .from(claims)
      .where(
        and(
          eq(claims.id, id),
          eq(claims.organizationId, req.user!.organizationId)
        )
      )
      .limit(1);

    if (!existing) {
      throw new AppError('Claim not found', 404);
    }

    await db.delete(claims).where(eq(claims.id, id));

    res.status(204).send();
  }),
};
