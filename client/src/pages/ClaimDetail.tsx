import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ExternalLink, Copy, Check, Trash2 } from 'lucide-react';
import { useState } from 'react';
import api from '@/services/api';
import type { Claim, ClaimStatus } from '@/types';
import { STATUS_COLORS } from '@/types';

export default function ClaimDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [copiedField, setCopiedField] = useState<string | null>(null);

  const { data: claim, isLoading } = useQuery<Claim>({
    queryKey: ['claims', id],
    queryFn: async () => {
      const response = await api.get(`/claims/${id}`);
      return response.data;
    },
  });

  const updateStatus = useMutation({
    mutationFn: async (status: ClaimStatus) => {
      await api.patch(`/claims/${id}`, { status });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['claims', id] });
      queryClient.invalidateQueries({ queryKey: ['claims'] });
    },
  });

  const deleteClaim = useMutation({
    mutationFn: async () => {
      await api.delete(`/claims/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['claims'] });
      navigate('/claims');
    },
  });

  const copyToClipboard = async (field: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 1500);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  if (!claim) {
    return <div className="text-center py-12 text-gray-500">Claim not found</div>;
  }

  const fields = [
    { label: 'Client Name', value: claim.clientName, key: 'clientName' },
    { label: 'Date of Birth', value: claim.clientDob, key: 'clientDob' },
    { label: 'Member ID', value: claim.memberId, key: 'memberId' },
    { label: 'Service Date', value: claim.serviceDate, key: 'serviceDate' },
    { label: 'CPT Code', value: claim.cptCode, key: 'cptCode' },
    { label: 'Modifier 1', value: claim.modifier1, key: 'modifier1' },
    { label: 'Modifier 2', value: claim.modifier2, key: 'modifier2' },
    { label: 'Units', value: claim.units?.toString(), key: 'units' },
    { label: 'Diagnosis Code', value: claim.diagnosisCode, key: 'diagnosisCode' },
    { label: 'Rendering Provider', value: claim.renderingProvider, key: 'provider' },
    { label: 'NPI', value: claim.npi, key: 'npi' },
    { label: 'Tax ID', value: claim.taxId, key: 'taxId' },
    { label: 'Place of Service', value: claim.placeOfService, key: 'pos' },
    {
      label: 'Charge Amount',
      value: claim.chargeAmount ? `$${claim.chargeAmount}` : undefined,
      key: 'charge',
    },
  ];

  const statuses: ClaimStatus[] = [
    'draft',
    'ready',
    'submitted',
    'pending',
    'paid',
    'denied',
  ];

  return (
    <div className="space-y-6">
      <button
        onClick={() => navigate('/claims')}
        className="flex items-center gap-2 text-gray-600 hover:text-gray-900"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to claims
      </button>

      <div className="card">
        <div className="flex items-start justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{claim.clientName}</h1>
            <p className="text-gray-600 mt-1">
              Service: {claim.serviceDate} - {claim.cptCode}
            </p>
          </div>
          <a
            href="#"
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" />
            Open Portal
          </a>
        </div>

        <div className="flex flex-wrap gap-2 mb-6">
          {statuses.map((status) => (
            <button
              key={status}
              onClick={() => updateStatus.mutate(status)}
              className="px-4 py-2 rounded-lg font-medium text-sm capitalize transition-colors"
              style={{
                backgroundColor:
                  claim.status === status
                    ? STATUS_COLORS[status]
                    : `${STATUS_COLORS[status]}15`,
                color: claim.status === status ? 'white' : STATUS_COLORS[status],
              }}
            >
              {status}
            </button>
          ))}
        </div>

        <div className="bg-gray-50 rounded-lg p-4 mb-6">
          <p className="text-sm text-gray-600">
            Click any field below to copy it to your clipboard
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {fields.map(
            (field) =>
              field.value && (
                <button
                  key={field.key}
                  onClick={() => copyToClipboard(field.key, field.value!)}
                  className="text-left p-3 bg-gray-50 hover:bg-gray-100 rounded-lg border border-gray-200 transition-colors"
                >
                  <div className="text-xs text-gray-500 mb-1">{field.label}</div>
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{field.value}</span>
                    {copiedField === field.key ? (
                      <Check className="w-4 h-4 text-green-600" />
                    ) : (
                      <Copy className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </button>
              )
          )}
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200 flex justify-between items-center">
          <p className="text-sm text-gray-500">
            Created: {new Date(claim.createdAt).toLocaleDateString()}
          </p>
          <button
            onClick={() => {
              if (confirm('Are you sure you want to delete this claim?')) {
                deleteClaim.mutate();
              }
            }}
            className="btn btn-danger flex items-center gap-2"
          >
            <Trash2 className="w-4 h-4" />
            Delete Claim
          </button>
        </div>
      </div>
    </div>
  );
}
