'use client';
import { useRouter } from 'next/navigation';
import { clearAuth, getUser } from '@/lib/auth';

export function AppNav() {
  const router = useRouter();
  const user = getUser();

  const handleLogout = () => {
    clearAuth();
    router.push('/auth');
  };

  return (
    <nav className="app-nav">
      <div className="app-nav__inner">
        <div className="app-nav__brand">
          <div className="app-nav__brand-icon">⚡</div>
          <span>Tesla Pool Dhaka</span>
        </div>
        {user && (
          <div className="app-nav__meta">
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {user.name}
            </span>
            <span className="app-nav__role-badge">{user.role}</span>
            <button className="app-nav__logout" onClick={handleLogout}>
              Log out
            </button>
          </div>
        )}
      </div>
    </nav>
  );
}
