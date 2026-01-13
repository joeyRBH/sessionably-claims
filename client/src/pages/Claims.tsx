import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, Filter } from 'lucide-react';
import api from '@/services/api';
import type { Claim, ClaimStatus } from '@/types';
import { STATUS_COLORS } from '@/types';

export default function Claims() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [search, setSearch] = useState('');

  const statusFilter = searchParams.get('status') as ClaimStatus | null;
  const payerFilter = searchParams.get('payer');

  const { data, isLoading } = useQuery({
    queryKey: ['claims', { status: statusFilter, payer: payerFilter, search }],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (payerFilter) params.set('payer', payerFilter);
      if (search) params.set('search', search);
      const response = await api.get(`/claims?${params.toString()}`);
      return response.data;
    },
  });

  const claims: Claim[] = data?.claims ?? [];

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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Claims</h1>
        <Link to="/claims/new" className="btn btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" />
          New Claim
        </Link>
      </div>

      <div className="card">
        <div className="flex flex-col md:flex-row gap-4 mb-6">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              type="text"
              placeholder="Search by client name..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input pl-10"
            />
          </div>
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-400" />
            <select
              value={statusFilter || ''}
              onChange={(e) => {
                if (e.target.value) {
                  searchParams.set('status', e.target.value);
                } else {
                  searchParams.delete('status');
                }
                setSearchParams(searchParams);
              }}
              className="input w-40"
            >
              <option value="">All Statuses</option>
              {statuses.map((status) => (
                <option key={status} value={status}>
                  {status.charAt(0).toUpperCase() + status.slice(1)}
                </option>
              ))}
            </select>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
          </div>
        ) : claims.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            No claims found.{' '}
            <Link to="/claims/new" className="text-primary-600 hover:underline">
              Create your first claim
            </Link>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-gray-200">
                <th className="text-left py-3 px-2 text-sm font-medium text-gray-500">
                  Client
                </th>
                <th className="text-left py-3 px-2 text-sm font-medium text-gray-500">
                  Service Date
                </th>
                <th className="text-left py-3 px-2 text-sm font-medium text-gray-500">
                  CPT
                </th>
                <th className="text-left py-3 px-2 text-sm font-medium text-gray-500">
                  Payer
                </th>
                <th className="text-left py-3 px-2 text-sm font-medium text-gray-500">
                  Deadline
                </th>
                <th className="text-left py-3 px-2 text-sm font-medium text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim) => (
                <tr
                  key={claim.id}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                  onClick={() => (window.location.href = `/claims/${claim.id}`)}
                >
                  <td className="py-3 px-2 font-medium">{claim.clientName}</td>
                  <td className="py-3 px-2 text-gray-600">{claim.serviceDate}</td>
                  <td className="py-3 px-2 text-gray-600">
                    {claim.cptCode}
                    {claim.modifier1 && `-${claim.modifier1}`}
                    {claim.modifier2 && `-${claim.modifier2}`}
                  </td>
                  <td className="py-3 px-2 text-gray-600">{claim.payerId}</td>
                  <td className="py-3 px-2">
                    <DeadlineDisplay
                      serviceDate={claim.serviceDate}
                      timelyFilingDays={90}
                    />
                  </td>
                  <td className="py-3 px-2">
                    <span
                      className="px-2 py-1 rounded-full text-xs font-medium capitalize"
                      style={{
                        backgroundColor: `${STATUS_COLORS[claim.status]}15`,
                        color: STATUS_COLORS[claim.status],
                      }}
                    >
                      {claim.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function DeadlineDisplay({
  serviceDate,
  timelyFilingDays,
}: {
  serviceDate: string;
  timelyFilingDays: number;
}) {
  const deadline = new Date(serviceDate);
  deadline.setDate(deadline.getDate() + timelyFilingDays);
  const today = new Date();
  const daysRemaining = Math.ceil(
    (deadline.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)
  );

  let color = '#059669';
  if (daysRemaining <= 14) color = '#DC2626';
  else if (daysRemaining <= 30) color = '#D97706';

  return (
    <span style={{ color, fontWeight: daysRemaining <= 14 ? 600 : 400 }}>
      {daysRemaining} days
    </span>
  );
}
