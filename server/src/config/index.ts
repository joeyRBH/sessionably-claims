import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Database
  databaseUrl: process.env.DATABASE_URL || '',

  // JWT
  jwtSecret: process.env.JWT_SECRET || 'your-super-secret-key-change-in-production',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '7d',

  // CORS
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3000',

  // Stedi API (for future integration)
  stediApiKey: process.env.STEDI_API_KEY || '',
  stediBaseUrl: process.env.STEDI_BASE_URL || 'https://healthcare.us.stedi.com/2024-04-01',
};

export type Config = typeof config;
