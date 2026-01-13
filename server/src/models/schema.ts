import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  numeric,
  boolean,
} from 'drizzle-orm/pg-core';

// Organizations table
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  npi: varchar('npi', { length: 10 }),
  taxId: varchar('tax_id', { length: 9 }),
  address: text('address'),
  city: varchar('city', { length: 100 }),
  state: varchar('state', { length: 2 }),
  zipCode: varchar('zip_code', { length: 10 }),
  phone: varchar('phone', { length: 20 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Users table
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  role: varchar('role', { length: 20 }).notNull().default('staff'),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Payers table
export const payers = pgTable('payers', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  portalUrl: text('portal_url').notNull(),
  timelyFilingDays: integer('timely_filing_days').notNull().default(90),
  color: varchar('color', { length: 7 }).notNull().default('#3B82F6'),
  payerId: varchar('payer_id', { length: 50 }),
  isActive: boolean('is_active').notNull().default(true),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Claims table
export const claims = pgTable('claims', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientName: varchar('client_name', { length: 255 }).notNull(),
  clientDob: varchar('client_dob', { length: 10 }),
  memberId: varchar('member_id', { length: 50 }),
  serviceDate: varchar('service_date', { length: 10 }).notNull(),
  cptCode: varchar('cpt_code', { length: 10 }).notNull(),
  modifier1: varchar('modifier_1', { length: 5 }),
  modifier2: varchar('modifier_2', { length: 5 }),
  modifier3: varchar('modifier_3', { length: 5 }),
  modifier4: varchar('modifier_4', { length: 5 }),
  units: integer('units').notNull().default(1),
  diagnosisCode: varchar('diagnosis_code', { length: 20 }).notNull(),
  payerId: uuid('payer_id')
    .notNull()
    .references(() => payers.id),
  renderingProvider: varchar('rendering_provider', { length: 255 }),
  npi: varchar('npi', { length: 10 }),
  taxId: varchar('tax_id', { length: 9 }),
  placeOfService: varchar('place_of_service', { length: 5 }).notNull().default('11'),
  chargeAmount: numeric('charge_amount', { precision: 10, scale: 2 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  submittedAt: timestamp('submitted_at'),
  paidAt: timestamp('paid_at'),
  paidAmount: numeric('paid_amount', { precision: 10, scale: 2 }),
  denialReason: text('denial_reason'),
  notes: text('notes'),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  createdBy: uuid('created_by')
    .notNull()
    .references(() => users.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// Audit log for HIPAA compliance
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').references(() => users.id),
  action: varchar('action', { length: 50 }).notNull(),
  resourceType: varchar('resource_type', { length: 50 }).notNull(),
  resourceId: uuid('resource_id'),
  details: text('details'),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: text('user_agent'),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Type exports
export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Payer = typeof payers.$inferSelect;
export type NewPayer = typeof payers.$inferInsert;
export type Claim = typeof claims.$inferSelect;
export type NewClaim = typeof claims.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
