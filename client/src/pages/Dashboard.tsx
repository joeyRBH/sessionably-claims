import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText, AlertTriangle, Clock, CheckCircle } from 'lucide-react';
import api from '@/services/api';
import type { ClaimStats, Payer, Claim } from '@/types';

export default function Dashboard() {
  const { data: stats } = useQuery<ClaimStats>({
    queryKey: ['claims', 'stats'],
    queryFn: async () => {
      const response = await api.get('/claims/stats');
      return response.data;
    },
  });

  const { data: payers } = useQuery<Payer[]>({
    queryKey: ['payers'],
    queryFn: async () => {
      const response = await api.get('/payers');
      return response.data;
    },
  });

  const { data: recentClaims } = useQuery<Claim[]>({
    queryKey: ['claims', 'recent'],
    queryFn: async () => {
      const response = await api.get('/claims?limit=5&sort=createdAt:desc');
      return response.data.claims;
    },
  });

  const statCards = [
    {
      label: 'Total Claims',
      value: stats?.total ?? 0,
      icon: FileText,
      color: 'text-gray-700',
    },
    {
      label: 'Ready to Submit',
      value: stats?.byStatus?.ready ?? 0,
      icon: Clock,
      color: 'text-primary-600',
    },
    {
      label: 'Pending Payment',
      value: stats?.byStatus?.pending ?? 0,
      icon: AlertTriangle,
      color: 'text-amber-600',
    },
    {
      label: 'Urgent Claims',
      value: stats?.urgent ?? 0,
      icon: CheckCircle,
      color: stats?.urgent ? 'text-red-600' : 'text-green-600',
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <Link to="/claims/new" className="btn btn-primary">
          + New Claim
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {statCards.map((stat) => (
          <div key={stat.label} className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-500">{stat.label}</p>
                <p className={`text-3xl font-bold ${stat.color}`}>{stat.value}</p>
              </div>
              <stat.icon className={`w-10 h-10 ${stat.color} opacity-20`} />
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Payer Queues</h2>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {payers?.map((payer) => (
            <Link
              key={payer.id}
              to={`/claims?payer=${payer.id}`}
              className="p-4 rounded-lg border-2 transition-colors hover:shadow-md"
              style={{
                borderColor: `${payer.color}40`,
                backgroundColor: `${payer.color}08`,
              }}
            >
              <h3 className="font-semibold" style={{ color: payer.color }}>
                {payer.name}
              </h3>
              <p className="text-2xl font-bold mt-1">
                {stats?.byPayer?.[payer.id] ?? 0}
              </p>
              <p className="text-sm text-gray-500">claims</p>
              <a
                href={payer.portalUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-block mt-2 px-3 py-1 text-xs text-white rounded"
                style={{ backgroundColor: payer.color }}
              >
                Open Portal
              </a>
            </Link>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Recent Claims</h2>
          <Link to="/claims" className="text-primary-600 hover:text-primary-700 text-sm">
            View all
          </Link>
        </div>
        {recentClaims?.length === 0 ? (
          <p className="text-gray-500 text-center py-8">
            No claims yet.{' '}
            <Link to="/claims/new" className="text-primary-600 hover:underline">
              Create your first claim
            </Link>
          </p>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="text-left py-2 text-sm font-medium text-gray-500">
                  Client
                </th>
                <th className="text-left py-2 text-sm font-medium text-gray-500">
                  Service Date
                </th>
                <th className="text-left py-2 text-sm font-medium text-gray-500">CPT</th>
                <th className="text-left py-2 text-sm font-medium text-gray-500">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {recentClaims?.map((claim) => (
                <tr
                  key={claim.id}
                  className="border-b border-gray-100 hover:bg-gray-50 cursor-pointer"
                >
                  <td className="py-3 font-medium">{claim.clientName}</td>
                  <td className="py-3 text-gray-600">{claim.serviceDate}</td>
                  <td className="py-3 text-gray-600">{claim.cptCode}</td>
                  <td className="py-3">
                    <span
                      className="px-2 py-1 rounded-full text-xs font-medium capitalize"
                      style={{
                        backgroundColor: `${getStatusColor(claim.status)}15`,
                        color: getStatusColor(claim.status),
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

function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    draft: '#6B7280',
    ready: '#2563EB',
    submitted: '#7C3AED',
    pending: '#D97706',
    paid: '#059669',
    denied: '#DC2626',
  };
  return colors[status] || '#6B7280';
}
