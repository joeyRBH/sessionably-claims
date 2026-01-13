import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';
import { organizations, users, payers } from '../models/schema.js';

const { Pool } = pg;

// Seed credentials from environment or use defaults for development
const SEED_ADMIN_CREDENTIAL = process.env.SEED_ADMIN_CREDENTIAL || 'changeme123';
const SEED_STAFF_CREDENTIAL = process.env.SEED_STAFF_CREDENTIAL || 'changeme456';

async function seed() {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.nodeEnv === 'production' ? { rejectUnauthorized: false } : false,
  });

  const db = drizzle(pool);

  console.log('Seeding database...');

  // Create default organization
  const [org] = await db
    .insert(organizations)
    .values({
      name: 'Resilient Behavioral Health',
      npi: '1234567890',
      taxId: '123456789',
      address: '123 Health Street',
      city: 'Denver',
      state: 'CO',
      zipCode: '80202',
      phone: '303-555-0100',
    })
    .returning();

  console.log('Created organization:', org.name);

  // Create admin user
  const adminHash = await bcrypt.hash(SEED_ADMIN_CREDENTIAL, 12);
  const [adminUser] = await db
    .insert(users)
    .values({
      email: 'admin@claimsub.com',
      passwordHash: adminHash,
      name: 'Admin User',
      role: 'admin',
      organizationId: org.id,
    })
    .returning();

  console.log('Created admin user:', adminUser.email);

  // Create staff user
  const staffHash = await bcrypt.hash(SEED_STAFF_CREDENTIAL, 12);
  const [staffUser] = await db
    .insert(users)
    .values({
      email: 'staff@claimsub.com',
      passwordHash: staffHash,
      name: 'Staff User',
      role: 'staff',
      organizationId: org.id,
    })
    .returning();

  console.log('Created staff user:', staffUser.email);

  // Create default payers
  const defaultPayers = [
    {
      name: 'Colorado Medicaid',
      portalUrl: 'https://colorado-hcp-portal.xco.dcs-usps.com/',
      timelyFilingDays: 90,
      color: '#059669',
      organizationId: org.id,
    },
    {
      name: 'Aetna',
      portalUrl: 'https://www.availity.com/',
      timelyFilingDays: 180,
      color: '#7C3AED',
      organizationId: org.id,
    },
    {
      name: 'Cigna',
      portalUrl: 'https://cignaforhcp.cigna.com/',
      timelyFilingDays: 180,
      color: '#0284C7',
      organizationId: org.id,
    },
    {
      name: 'UBH / Optum',
      portalUrl: 'https://www.providerexpress.com/',
      timelyFilingDays: 180,
      color: '#EA580C',
      organizationId: org.id,
    },
  ];

  await db.insert(payers).values(defaultPayers);

  console.log('Created default payers');

  console.log('Seeding completed!');
  console.log('\nDefault users created:');
  console.log('Admin: admin@claimsub.com');
  console.log('Staff: staff@claimsub.com');
  console.log('Set SEED_ADMIN_CREDENTIAL and SEED_STAFF_CREDENTIAL env vars for credentials');

  await pool.end();
}

seed().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
