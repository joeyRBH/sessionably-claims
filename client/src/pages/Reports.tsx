import { useQuery } from '@tanstack/react-query';
import api from '@/services/api';
import type { ClaimStats, Payer, ClaimStatus } from '@/types';
import { STATUS_COLORS } from '@/types';

export default function Reports() {
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

  const total = stats?.total || 1;
  const submitted =
    (stats?.byStatus?.submitted || 0) +
    (stats?.byStatus?.pending || 0) +
    (stats?.byStatus?.paid || 0) +
    (stats?.byStatus?.denied || 0);

  const submissionRate = Math.round((submitted / total) * 100);
  const paymentRate = Math.round(((stats?.byStatus?.paid || 0) / total) * 100);
  const denialRate = Math.round(((stats?.byStatus?.denied || 0) / total) * 100);

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
      <h1 className="text-2xl font-bold text-gray-900">Reports</h1>

      <div className="card">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-4">By Status</h3>
            <div className="space-y-3">
              {statuses.map((status) => {
                const count = stats?.byStatus?.[status] || 0;
                const percentage = (count / total) * 100;
                return (
                  <div key={status} className="flex items-center gap-3">
                    <span
                      className="w-24 text-sm font-medium capitalize"
                      style={{ color: STATUS_COLORS[status] }}
                    >
                      {status}
                    </span>
                    <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-full transition-all duration-300"
                        style={{
                          width: `${percentage}%`,
                          backgroundColor: STATUS_COLORS[status],
                        }}
                      />
                    </div>
                    <span className="w-10 text-right text-sm font-medium">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-500 mb-4">By Payer</h3>
            <div className="space-y-3">
              {payers?.map((payer) => {
                const count = stats?.byPayer?.[payer.id] || 0;
                const percentage = (count / total) * 100;
                return (
                  <div key={payer.id} className="flex items-center gap-3">
                    <span
                      className="w-24 text-sm font-medium truncate"
                      style={{ color: payer.color }}
                    >
                      {payer.name}
                    </span>
                    <div className="flex-1 h-6 bg-gray-100 rounded overflow-hidden">
                      <div
                        className="h-full transition-all duration-300"
                        style={{
                          width: `${percentage}%`,
                          backgroundColor: payer.color,
                        }}
                      />
                    </div>
                    <span className="w-10 text-right text-sm font-medium">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="mt-8 pt-6 border-t border-gray-200">
          <h3 className="text-sm font-medium text-gray-500 mb-4">Quick Stats</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <div>
              <p className="text-sm text-gray-500">Submission Rate</p>
              <p className="text-2xl font-semibold">{submissionRate}%</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Payment Rate</p>
              <p className="text-2xl font-semibold text-green-600">{paymentRate}%</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Denial Rate</p>
              <p className="text-2xl font-semibold text-red-600">{denialRate}%</p>
            </div>
            <div>
              <p className="text-sm text-gray-500">Total Claims</p>
              <p className="text-2xl font-semibold">{stats?.total || 0}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
