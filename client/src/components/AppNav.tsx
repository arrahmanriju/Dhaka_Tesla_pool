'use client';
import { useRouter } from 'next/navigation';
import { clearAuth, getUser } from '@/lib/auth';
import { usePreferences } from '@/lib/preferences';
import { PreferenceControls } from './PreferenceControls';

export function AppNav() {
  const router = useRouter();
  const user = getUser();
  const { t } = usePreferences();

  const handleLogout = () => {
    clearAuth();
    router.push('/auth');
  };

  return (
    <nav className="app-nav">
      <div className="app-nav__inner">
        <div className="app-nav__brand">
          <div className="app-nav__brand-icon">⚡</div>
          <span>{t('app.name')}</span>
        </div>
        {user && (
          <div className="app-nav__meta">
            <span className="app-nav__user">{user.name}</span>
            <span className="app-nav__role-badge">{t(`role.${user.role}`)}</span>
            <button className="app-nav__logout" onClick={handleLogout}>
              {t('nav.logout')}
            </button>
          </div>
        )}
        <PreferenceControls />
      </div>
    </nav>
  );
}
