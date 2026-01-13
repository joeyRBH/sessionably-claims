import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import api from '@/services/api';
import { CPT_CODES, MODIFIERS, PLACES_OF_SERVICE } from '@/types';
import type { Payer } from '@/types';

const claimSchema = z.object({
  clientName: z.string().min(1, 'Client name is required'),
  clientDob: z.string().optional(),
  memberId: z.string().optional(),
  serviceDate: z.string().min(1, 'Service date is required'),
  cptCode: z.string().min(1, 'CPT code is required'),
  modifier1: z.string().optional(),
  modifier2: z.string().optional(),
  modifier3: z.string().optional(),
  modifier4: z.string().optional(),
  units: z.number().min(1).default(1),
  diagnosisCode: z.string().min(1, 'Diagnosis code is required'),
  payerId: z.string().min(1, 'Payer is required'),
  renderingProvider: z.string().optional(),
  npi: z.string().optional(),
  taxId: z.string().optional(),
  placeOfService: z.string().default('11'),
  chargeAmount: z.number().optional(),
});

type ClaimForm = z.infer<typeof claimSchema>;

export default function NewClaim() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: payers } = useQuery<Payer[]>({
    queryKey: ['payers'],
    queryFn: async () => {
      const response = await api.get('/payers');
      return response.data;
    },
  });

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ClaimForm>({
    resolver: zodResolver(claimSchema),
    defaultValues: {
      units: 1,
      placeOfService: '11',
    },
  });

  const createClaim = useMutation({
    mutationFn: async (data: ClaimForm) => {
      const response = await api.post('/claims', { ...data, status: 'draft' });
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['claims'] });
      navigate('/claims');
    },
  });

  const onSubmit = (data: ClaimForm) => {
    createClaim.mutate(data);
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">New Claim</h1>

      <form onSubmit={handleSubmit(onSubmit)} className="card">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="label">Client Name *</label>
            <input {...register('clientName')} className="input" />
            {errors.clientName && (
              <p className="text-sm text-red-600 mt-1">{errors.clientName.message}</p>
            )}
          </div>

          <div>
            <label className="label">Date of Birth</label>
            <input type="date" {...register('clientDob')} className="input" />
          </div>

          <div>
            <label className="label">Member ID</label>
            <input {...register('memberId')} className="input" />
          </div>

          <div>
            <label className="label">Service Date *</label>
            <input type="date" {...register('serviceDate')} className="input" />
            {errors.serviceDate && (
              <p className="text-sm text-red-600 mt-1">{errors.serviceDate.message}</p>
            )}
          </div>

          <div>
            <label className="label">CPT Code *</label>
            <select {...register('cptCode')} className="input">
              {CPT_CODES.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Modifier 1</label>
            <select {...register('modifier1')} className="input">
              {MODIFIERS.map((mod) => (
                <option key={mod.code} value={mod.code}>
                  {mod.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Modifier 2</label>
            <select {...register('modifier2')} className="input">
              {MODIFIERS.map((mod) => (
                <option key={mod.code} value={mod.code}>
                  {mod.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Modifier 3</label>
            <select {...register('modifier3')} className="input">
              {MODIFIERS.map((mod) => (
                <option key={mod.code} value={mod.code}>
                  {mod.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Modifier 4</label>
            <select {...register('modifier4')} className="input">
              {MODIFIERS.map((mod) => (
                <option key={mod.code} value={mod.code}>
                  {mod.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Units</label>
            <input
              type="number"
              {...register('units', { valueAsNumber: true })}
              className="input"
            />
          </div>

          <div>
            <label className="label">Diagnosis Code (ICD-10) *</label>
            <input
              {...register('diagnosisCode')}
              placeholder="F32.1"
              className="input"
            />
            {errors.diagnosisCode && (
              <p className="text-sm text-red-600 mt-1">{errors.diagnosisCode.message}</p>
            )}
          </div>

          <div>
            <label className="label">Payer *</label>
            <select {...register('payerId')} className="input">
              <option value="">Select payer...</option>
              {payers?.map((payer) => (
                <option key={payer.id} value={payer.id}>
                  {payer.name}
                </option>
              ))}
            </select>
            {errors.payerId && (
              <p className="text-sm text-red-600 mt-1">{errors.payerId.message}</p>
            )}
          </div>

          <div>
            <label className="label">Rendering Provider</label>
            <input {...register('renderingProvider')} className="input" />
          </div>

          <div>
            <label className="label">NPI</label>
            <input {...register('npi')} className="input" />
          </div>

          <div>
            <label className="label">Tax ID</label>
            <input {...register('taxId')} className="input" />
          </div>

          <div>
            <label className="label">Place of Service</label>
            <select {...register('placeOfService')} className="input">
              {PLACES_OF_SERVICE.map((pos) => (
                <option key={pos.code} value={pos.code}>
                  {pos.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">Charge Amount</label>
            <input
              type="number"
              step="0.01"
              {...register('chargeAmount', { valueAsNumber: true })}
              placeholder="150.00"
              className="input"
            />
          </div>
        </div>

        <div className="mt-6 flex gap-3">
          <button type="submit" disabled={isSubmitting} className="btn btn-primary">
            {isSubmitting ? 'Saving...' : 'Save Claim'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/claims')}
            className="btn btn-secondary"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
