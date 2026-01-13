import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../config/index.js';
import { asyncHandler, AppError } from '../middleware/errorHandler.js';
import { AuthRequest, JwtPayload } from '../middleware/auth.js';
import { db } from '../database/index.js';
import { users } from '../models/schema.js';
import { eq } from 'drizzle-orm';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
  organizationId: z.string().uuid(),
});

const changeCredentialSchema = z.object({
  existing: z.string().min(1),
  updated: z.string().min(8),
});

function generateToken(payload: JwtPayload): string {
  return jwt.sign(payload, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
  });
}

export const authController = {
  login: asyncHandler(async (req: Request, res: Response) => {
    const { email, password } = loginSchema.parse(req.body);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (!user) {
      throw new AppError('Invalid email or password', 401);
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      throw new AppError('Invalid email or password', 401);
    }

    const token = generateToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
    });

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  }),

  register: asyncHandler(async (req: Request, res: Response) => {
    const { email, password, name, organizationId } = registerSchema.parse(req.body);

    const [existingUser] = await db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);

    if (existingUser) {
      throw new AppError('Email already registered', 400);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const [user] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        passwordHash,
        name,
        role: 'staff',
        organizationId,
      })
      .returning();

    const token = generateToken({
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      organizationId: user.organizationId,
    });

    res.status(201).json({
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  }),

  me: asyncHandler(async (req: AuthRequest, res: Response) => {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);

    if (!user) {
      throw new AppError('User not found', 404);
    }

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
        organizationId: user.organizationId,
      },
    });
  }),

  changeCredential: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { existing, updated } = changeCredentialSchema.parse(req.body);

    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);

    if (!user) {
      throw new AppError('User not found', 404);
    }

    const isValid = await bcrypt.compare(existing, user.passwordHash);
    if (!isValid) {
      throw new AppError('Current credential is incorrect', 400);
    }

    const hash = await bcrypt.hash(updated, 12);

    await db
      .update(users)
      .set({ passwordHash: hash, updatedAt: new Date() })
      .where(eq(users.id, req.user!.id));

    res.json({ message: 'Credential updated successfully' });
  }),
};
