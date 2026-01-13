import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Plus, Edit2, Trash2, ExternalLink } from 'lucide-react';
import api from '@/services/api';
import type { Payer } from '@/types';

const payerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  portalUrl: z.string().url('Must be a valid URL'),
  timelyFilingDays: z.number().min(1, 'Must be at least 1 day'),
  color: z.string().default('#3B82F6'),
  payerId: z.string().optional(),
});

type PayerForm = z.infer<typeof payerSchema>;

export default function Payers() {
  const queryClient = useQueryClient();
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPayer, setEditingPayer] = useState<Payer | null>(null);

  const { data: payers, isLoading } = useQuery<Payer[]>({
    queryKey: ['payers'],
    queryFn: async () => {
      const response = await api.get('/payers');
      return response.data;
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PayerForm>({
    resolver: zodResolver(payerSchema),
    defaultValues: {
      color: '#3B82F6',
      timelyFilingDays: 90,
    },
  });

  const createPayer = useMutation({
    mutationFn: async (data: PayerForm) => {
      const response = await api.post('/payers', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payers'] });
      closeModal();
    },
  });

  const updatePayer = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: PayerForm }) => {
      const response = await api.patch(`/payers/${id}`, data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payers'] });
      closeModal();
    },
  });

  const deletePayer = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/payers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['payers'] });
    },
  });

  const openModal = (payer?: Payer) => {
    if (payer) {
      setEditingPayer(payer);
      reset({
        name: payer.name,
        portalUrl: payer.portalUrl,
        timelyFilingDays: payer.timelyFilingDays,
        color: payer.color,
        payerId: payer.payerId,
      });
    } else {
      setEditingPayer(null);
      reset({
        color: '#3B82F6',
        timelyFilingDays: 90,
      });
    }
    setIsModalOpen(true);
  };

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingPayer(null);
    reset();
  };

  const onSubmit = (data: PayerForm) => {
    if (editingPayer) {
      updatePayer.mutate({ id: editingPayer.id, data });
    } else {
      createPayer.mutate(data);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Payers</h1>
        <button onClick={() => openModal()} className="btn btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add Payer
        </button>
      </div>

      <div className="card">
        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : payers?.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No payers configured yet.{' '}
            <button onClick={() => openModal()} className="text-primary-600 hover:underline">
              Add your first payer
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {payers?.map((payer) => (
              <div
                key={payer.id}
                className="flex items-center justify-between p-4 border border-gray-200 rounded-lg"
              >
                <div className="flex items-center gap-3">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: payer.color }}
                  />
                  <div>
                    <h3 className="font-medium">{payer.name}</h3>
                    <p className="text-sm text-gray-500">
                      {payer.timelyFilingDays} days filing -{' '}
                      <a
                        href={payer.portalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-600 hover:underline inline-flex items-center gap-1"
                      >
                        Portal <ExternalLink className="w-3 h-3" />
                      </a>
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => openModal(payer)}
                    className="p-2 text-primary-600 hover:bg-primary-50 rounded-lg"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete ${payer.name}?`)) {
                        deletePayer.mutate(payer.id);
                      }
                    }}
                    className="p-2 text-red-600 hover:bg-red-50 rounded-lg"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {isModalOpen && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={closeModal}
        >
          <div
            className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6 border-b border-gray-200">
              <h2 className="text-lg font-semibold">
                {editingPayer ? 'Edit Payer' : 'Add Payer'}
              </h2>
            </div>
            <form onSubmit={handleSubmit(onSubmit)} className="p-6 space-y-4">
              <div>
                <label className="label">Payer Name *</label>
                <input {...register('name')} className="input" />
                {errors.name && (
                  <p className="text-sm text-red-600 mt-1">{errors.name.message}</p>
                )}
              </div>
              <div>
                <label className="label">Portal URL *</label>
                <input {...register('portalUrl')} placeholder="https://..." className="input" />
                {errors.portalUrl && (
                  <p className="text-sm text-red-600 mt-1">{errors.portalUrl.message}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">Timely Filing (days) *</label>
                  <input
                    type="number"
                    {...register('timelyFilingDays', { valueAsNumber: true })}
                    className="input"
                  />
                  {errors.timelyFilingDays && (
                    <p className="text-sm text-red-600 mt-1">
                      {errors.timelyFilingDays.message}
                    </p>
                  )}
                </div>
                <div>
                  <label className="label">Brand Color</label>
                  <input type="color" {...register('color')} className="input h-10" />
                </div>
              </div>
              <div>
                <label className="label">Payer ID (optional)</label>
                <input {...register('payerId')} placeholder="Clearinghouse payer ID" className="input" />
              </div>
              <div className="flex justify-end gap-3 pt-4">
                <button type="button" onClick={closeModal} className="btn btn-secondary">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  {editingPayer ? 'Save Changes' : 'Add Payer'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
