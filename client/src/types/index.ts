export type ClaimStatus = 'draft' | 'ready' | 'submitted' | 'pending' | 'paid' | 'denied';

export interface Claim {
  id: string;
  clientName: string;
  clientDob: string;
  memberId: string;
  serviceDate: string;
  cptCode: string;
  modifier1?: string;
  modifier2?: string;
  modifier3?: string;
  modifier4?: string;
  units: number;
  diagnosisCode: string;
  payerId: string;
  renderingProvider: string;
  npi?: string;
  taxId?: string;
  placeOfService: string;
  chargeAmount?: number;
  status: ClaimStatus;
  submittedAt?: string;
  paidAt?: string;
  paidAmount?: number;
  denialReason?: string;
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Payer {
  id: string;
  name: string;
  portalUrl: string;
  timelyFilingDays: number;
  color: string;
  payerId?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'staff';
  organizationId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  name: string;
  npi: string;
  taxId: string;
  address: string;
  city: string;
  state: string;
  zipCode: string;
  phone: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimStats {
  total: number;
  byStatus: Record<ClaimStatus, number>;
  byPayer: Record<string, number>;
  urgent: number;
}

export const CPT_CODES = [
  '90834',
  '90837',
  '90847',
  '90853',
  '90791',
  '90792',
  '96130',
  '96131',
  '96136',
  '96137',
];

export const MODIFIERS = [
  { code: '', label: 'None' },
  { code: '95', label: '95 - Synchronous Telehealth' },
  { code: 'GT', label: 'GT - Interactive Telehealth' },
  { code: 'HO', label: 'HO - Masters Level Clinician' },
  { code: 'HN', label: 'HN - Bachelors Level Clinician' },
  { code: 'AJ', label: 'AJ - Clinical Social Worker' },
  { code: 'AH', label: 'AH - Clinical Psychologist' },
  { code: 'U1', label: 'U1 - Medicaid Level 1' },
  { code: 'U2', label: 'U2 - Medicaid Level 2' },
  { code: 'U3', label: 'U3 - Medicaid Level 3' },
  { code: 'U4', label: 'U4 - Medicaid Level 4' },
  { code: 'U5', label: 'U5 - Medicaid Level 5' },
  { code: 'FQ', label: 'FQ - Telehealth in Patient Home' },
  { code: '59', label: '59 - Distinct Procedural Service' },
  { code: '76', label: '76 - Repeat Procedure Same Physician' },
  { code: '25', label: '25 - Significant E/M' },
];

export const PLACES_OF_SERVICE = [
  { code: '02', label: '02 - Telehealth' },
  { code: '10', label: '10 - Telehealth (Patient Home)' },
  { code: '11', label: '11 - Office' },
  { code: '12', label: '12 - Home' },
  { code: '53', label: '53 - Community Mental Health Center' },
];

export const STATUS_COLORS: Record<ClaimStatus, string> = {
  draft: '#6B7280',
  ready: '#2563EB',
  submitted: '#7C3AED',
  pending: '#D97706',
  paid: '#059669',
  denied: '#DC2626',
};
