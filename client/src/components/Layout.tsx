import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '@/context/AuthContext';
import {
  LayoutDashboard,
  FileText,
  Building2,
  BarChart3,
  Settings,
  LogOut,
} from 'lucide-react';
import clsx from 'clsx';

const navigation = [
  { name: 'Dashboard', href: '/', icon: LayoutDashboard },
  { name: 'Claims', href: '/claims', icon: FileText },
  { name: 'Payers', href: '/payers', icon: Building2 },
  { name: 'Reports', href: '/reports', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="min-h-screen bg-gray-100">
      <header className="bg-gray-800 text-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <svg
                className="w-8 h-8"
                viewBox="0 0 100 100"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <ellipse cx="50" cy="55" rx="38" ry="20" fill="#3B82F6" />
                <rect x="42" y="32" width="16" height="18" rx="3" fill="#2563EB" />
                <rect x="46" y="26" width="8" height="8" rx="2" fill="#1D4ED8" />
                <rect x="48" y="18" width="4" height="12" fill="#9CA3AF" />
                <circle cx="50" cy="16" r="4" fill="#6B7280" />
                <circle cx="30" cy="55" r="5" fill="#1E40AF" />
                <circle cx="30" cy="55" r="3" fill="#60A5FA" />
                <circle cx="50" cy="55" r="5" fill="#1E40AF" />
                <circle cx="50" cy="55" r="3" fill="#60A5FA" />
                <circle cx="70" cy="55" r="5" fill="#1E40AF" />
                <circle cx="70" cy="55" r="3" fill="#60A5FA" />
              </svg>
              <span className="text-lg font-semibold">ClaimSub</span>
            </div>

            <nav className="flex items-center gap-1">
              {navigation.map((item) => (
                <NavLink
                  key={item.name}
                  to={item.href}
                  end={item.href === '/'}
                  className={({ isActive }) =>
                    clsx(
                      'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-primary-600 text-white'
                        : 'text-gray-300 hover:bg-gray-700 hover:text-white'
                    )
                  }
                >
                  <item.icon className="w-4 h-4" />
                  {item.name}
                </NavLink>
              ))}
            </nav>

            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-300">{user?.name}</span>
              <button
                onClick={handleLogout}
                className="flex items-center gap-2 px-3 py-2 bg-red-600 hover:bg-red-700 rounded-lg text-sm font-medium transition-colors"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Outlet />
      </main>
    </div>
  );
}
