import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/context/AuthContext';
import api from '@/services/api';
import type { Organization } from '@/types';

const organizationSchema = z.object({
  name: z.string().min(1, 'Organization name is required'),
  npi: z.string().min(10, 'NPI must be 10 digits').max(10),
  taxId: z.string().min(9, 'Tax ID must be 9 digits').max(9),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  zipCode: z.string().optional(),
  phone: z.string().optional(),
});

const credentialSchema = z
  .object({
    existingCredential: z.string().min(1, 'Current credential is required'),
    updatedCredential: z.string().min(8, 'Must be at least 8 characters'),
    confirmCredential: z.string().min(1, 'Please confirm your entry'),
  })
  .refine((data) => data.updatedCredential === data.confirmCredential, {
    message: "Entries don't match",
    path: ['confirmCredential'],
  });

type OrganizationForm = z.infer<typeof organizationSchema>;
type CredentialForm = z.infer<typeof credentialSchema>;

export default function Settings() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: organization } = useQuery<Organization>({
    queryKey: ['organization'],
    queryFn: async () => {
      const response = await api.get('/organization');
      return response.data;
    },
  });

  const orgForm = useForm<OrganizationForm>({
    resolver: zodResolver(organizationSchema),
    values: organization
      ? {
          name: organization.name,
          npi: organization.npi,
          taxId: organization.taxId,
          address: organization.address,
          city: organization.city,
          state: organization.state,
          zipCode: organization.zipCode,
          phone: organization.phone,
        }
      : undefined,
  });

  const credentialForm = useForm<CredentialForm>({
    resolver: zodResolver(credentialSchema),
  });

  const updateOrganization = useMutation({
    mutationFn: async (data: OrganizationForm) => {
      const response = await api.patch('/organization', data);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['organization'] });
    },
  });

  const updateCredential = useMutation({
    mutationFn: async (data: CredentialForm) => {
      await api.post('/auth/change-credential', {
        existing: data.existingCredential,
        updated: data.updatedCredential,
      });
    },
    onSuccess: () => {
      credentialForm.reset();
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Settings</h1>

      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Profile</h2>
        <div className="space-y-2 text-sm">
          <p>
            <span className="text-gray-500">Name:</span> {user?.name}
          </p>
          <p>
            <span className="text-gray-500">Email:</span> {user?.email}
          </p>
          <p>
            <span className="text-gray-500">Role:</span>{' '}
            <span className="capitalize">{user?.role}</span>
          </p>
        </div>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Organization</h2>
        <form
          onSubmit={orgForm.handleSubmit((data) => updateOrganization.mutate(data))}
          className="space-y-4"
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Organization Name *</label>
              <input {...orgForm.register('name')} className="input" />
              {orgForm.formState.errors.name && (
                <p className="text-sm text-red-600 mt-1">
                  {orgForm.formState.errors.name.message}
                </p>
              )}
            </div>
            <div>
              <label className="label">NPI *</label>
              <input {...orgForm.register('npi')} maxLength={10} className="input" />
              {orgForm.formState.errors.npi && (
                <p className="text-sm text-red-600 mt-1">
                  {orgForm.formState.errors.npi.message}
                </p>
              )}
            </div>
            <div>
              <label className="label">Tax ID *</label>
              <input {...orgForm.register('taxId')} maxLength={9} className="input" />
              {orgForm.formState.errors.taxId && (
                <p className="text-sm text-red-600 mt-1">
                  {orgForm.formState.errors.taxId.message}
                </p>
              )}
            </div>
            <div>
              <label className="label">Phone</label>
              <input {...orgForm.register('phone')} className="input" />
            </div>
            <div className="md:col-span-2">
              <label className="label">Address</label>
              <input {...orgForm.register('address')} className="input" />
            </div>
            <div>
              <label className="label">City</label>
              <input {...orgForm.register('city')} className="input" />
            </div>
            <div>
              <label className="label">State</label>
              <input {...orgForm.register('state')} maxLength={2} className="input" />
            </div>
            <div>
              <label className="label">ZIP Code</label>
              <input {...orgForm.register('zipCode')} className="input" />
            </div>
          </div>
          <button
            type="submit"
            disabled={updateOrganization.isPending}
            className="btn btn-primary"
          >
            {updateOrganization.isPending ? 'Saving...' : 'Save Organization'}
          </button>
        </form>
      </div>

      <div className="card">
        <h2 className="text-lg font-semibold mb-4">Update Credentials</h2>
        <form
          onSubmit={credentialForm.handleSubmit((data) => updateCredential.mutate(data))}
          className="space-y-4 max-w-md"
        >
          <div>
            <label className="label">Current</label>
            <input
              type="password"
              {...credentialForm.register('existingCredential')}
              className="input"
            />
            {credentialForm.formState.errors.existingCredential && (
              <p className="text-sm text-red-600 mt-1">
                {credentialForm.formState.errors.existingCredential.message}
              </p>
            )}
          </div>
          <div>
            <label className="label">New</label>
            <input
              type="password"
              {...credentialForm.register('updatedCredential')}
              className="input"
            />
            {credentialForm.formState.errors.updatedCredential && (
              <p className="text-sm text-red-600 mt-1">
                {credentialForm.formState.errors.updatedCredential.message}
              </p>
            )}
          </div>
          <div>
            <label className="label">Confirm New</label>
            <input
              type="password"
              {...credentialForm.register('confirmCredential')}
              className="input"
            />
            {credentialForm.formState.errors.confirmCredential && (
              <p className="text-sm text-red-600 mt-1">
                {credentialForm.formState.errors.confirmCredential.message}
              </p>
            )}
          </div>
          <button
            type="submit"
            disabled={updateCredential.isPending}
            className="btn btn-primary"
          >
            {updateCredential.isPending ? 'Updating...' : 'Update'}
          </button>
        </form>
      </div>
    </div>
  );
}
