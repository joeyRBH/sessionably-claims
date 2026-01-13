import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useAuth } from '@/context/AuthContext';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

type LoginForm = z.infer<typeof loginSchema>;

export default function Login() {
  const navigate = useNavigate();
  const { login } = useAuth();
  const [error, setError] = useState('');

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginForm>({
    resolver: zodResolver(loginSchema),
  });

  async function onSubmit(data: LoginForm) {
    try {
      setError('');
      await login(data.email, data.password);
      navigate('/');
    } catch {
      setError('Invalid email or password');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-gray-800 to-gray-900">
      <div className="bg-white p-10 rounded-2xl shadow-2xl w-full max-w-md">
        <div className="text-center mb-8">
          <svg
            className="w-16 h-16 mx-auto mb-4"
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <ellipse cx="50" cy="55" rx="38" ry="20" fill="#3B82F6" />
            <rect x="42" y="32" width="16" height="18" rx="3" fill="#2563EB" />
            <rect x="46" y="26" width="8" height="8" rx="2" fill="#1D4ED8" />
            <rect x="48" y="18" width="4" height="12" fill="#6B7280" />
            <circle cx="50" cy="16" r="4" fill="#374151" />
            <circle cx="30" cy="55" r="5" fill="#1E40AF" />
            <circle cx="30" cy="55" r="3" fill="#60A5FA" />
            <circle cx="50" cy="55" r="5" fill="#1E40AF" />
            <circle cx="50" cy="55" r="3" fill="#60A5FA" />
            <circle cx="70" cy="55" r="5" fill="#1E40AF" />
            <circle cx="70" cy="55" r="3" fill="#60A5FA" />
          </svg>
          <h1 className="text-2xl font-bold text-gray-900">Welcome to ClaimSub</h1>
          <p className="text-gray-600 mt-2">Sign in to manage your claims</p>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg text-red-600 text-sm">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div>
            <label htmlFor="email" className="label">
              Email
            </label>
            <input
              {...register('email')}
              type="email"
              id="email"
              className="input"
              placeholder="Enter your email"
            />
            {errors.email && (
              <p className="mt-1 text-sm text-red-600">{errors.email.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="password" className="label">
              Password
            </label>
            <input
              {...register('password')}
              type="password"
              id="password"
              className="input"
              placeholder="Enter your password"
            />
            {errors.password && (
              <p className="mt-1 text-sm text-red-600">{errors.password.message}</p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="w-full btn btn-primary py-3 text-base"
          >
            {isSubmitting ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
}
