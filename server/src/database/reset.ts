import pg from 'pg';
import { config } from '../config/index.js';

const { Pool } = pg;

async function reset() {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  });

  console.log('Resetting database...');

  // Drop all tables in the correct order (respecting foreign keys)
  await pool.query(`
    DROP TABLE IF EXISTS audit_logs CASCADE;
    DROP TABLE IF EXISTS claims CASCADE;
    DROP TABLE IF EXISTS payers CASCADE;
    DROP TABLE IF EXISTS users CASCADE;
    DROP TABLE IF EXISTS organizations CASCADE;
  `);

  console.log('All tables dropped.');

  // Recreate tables
  await pool.query(`
    CREATE TABLE organizations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      npi VARCHAR(10),
      tax_id VARCHAR(9),
      address TEXT,
      city VARCHAR(100),
      state VARCHAR(2),
      zip_code VARCHAR(10),
      phone VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'staff',
      organization_id UUID NOT NULL REFERENCES organizations(id),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE payers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name VARCHAR(255) NOT NULL,
      portal_url TEXT NOT NULL,
      timely_filing_days INTEGER NOT NULL DEFAULT 90,
      color VARCHAR(7) NOT NULL DEFAULT '#3B82F6',
      payer_id VARCHAR(50),
      is_active BOOLEAN NOT NULL DEFAULT true,
      organization_id UUID NOT NULL REFERENCES organizations(id),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE claims (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      client_name VARCHAR(255) NOT NULL,
      client_dob VARCHAR(10),
      member_id VARCHAR(50),
      service_date VARCHAR(10) NOT NULL,
      cpt_code VARCHAR(10) NOT NULL,
      modifier_1 VARCHAR(5),
      modifier_2 VARCHAR(5),
      modifier_3 VARCHAR(5),
      modifier_4 VARCHAR(5),
      units INTEGER NOT NULL DEFAULT 1,
      diagnosis_code VARCHAR(20) NOT NULL,
      payer_id UUID NOT NULL REFERENCES payers(id),
      rendering_provider VARCHAR(255),
      npi VARCHAR(10),
      tax_id VARCHAR(9),
      place_of_service VARCHAR(5) NOT NULL DEFAULT '11',
      charge_amount NUMERIC(10, 2),
      status VARCHAR(20) NOT NULL DEFAULT 'draft',
      submitted_at TIMESTAMP,
      paid_at TIMESTAMP,
      paid_amount NUMERIC(10, 2),
      denial_reason TEXT,
      notes TEXT,
      organization_id UUID NOT NULL REFERENCES organizations(id),
      created_by UUID NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      updated_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE TABLE audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id),
      action VARCHAR(50) NOT NULL,
      resource_type VARCHAR(50) NOT NULL,
      resource_id UUID,
      details TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      organization_id UUID NOT NULL REFERENCES organizations(id),
      created_at TIMESTAMP DEFAULT NOW() NOT NULL
    );

    CREATE INDEX idx_claims_organization ON claims(organization_id);
    CREATE INDEX idx_claims_status ON claims(status);
    CREATE INDEX idx_claims_payer ON claims(payer_id);
    CREATE INDEX idx_claims_service_date ON claims(service_date);
    CREATE INDEX idx_users_organization ON users(organization_id);
    CREATE INDEX idx_payers_organization ON payers(organization_id);
    CREATE INDEX idx_audit_logs_organization ON audit_logs(organization_id);
    CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
  `);

  console.log('Tables recreated.');

  await pool.end();
  console.log('Database reset complete. Run npm run db:seed to add seed data.');
}

reset().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
