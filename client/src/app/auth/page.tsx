'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { authApi, type Role } from '@/lib/api';
import { saveAuth } from '@/lib/auth';
import { normalizePhone } from '@/lib/phone';
import { Spinner, ErrorBanner } from '@/components/UI';
import { PreferenceControls } from '@/components/PreferenceControls';
import { usePreferences, useFormatApiError } from '@/lib/preferences';

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('PASSENGER');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();
  const { t } = usePreferences();
  const formatError = useFormatApiError();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    const normalizedPhone = normalizePhone(phone);
    if (!normalizedPhone) { setError(t('auth.phoneInvalid')); return; }
    setLoading(true);
    try {
      const data = isLogin
        ? await authApi.login(normalizedPhone, password)
        : await authApi.signup(name, normalizedPhone, email.trim(), password, role);

      saveAuth(data.token, data.user);
      // A brand-new driver still has to onboard (vehicle, NID, home zone) before going online.
      const nextDriverPage = isLogin ? '/driver' : '/driver/onboarding';
      router.push(data.user.role === 'DRIVER' ? nextDriverPage : '/passenger');
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <PreferenceControls floating />
      <div className="auth-card animate-in">
        {/* Brand */}
        <div className="auth-card__brand">
          <div className="auth-card__brand-icon">⚡</div>
          <span className="auth-card__brand-name">{t('app.name')}</span>
        </div>

        <h1 className="auth-card__title">
          {isLogin ? t('auth.welcome') : t('auth.create')}
        </h1>
        <p className="auth-card__sub">
          {isLogin ? t('auth.subLogin') : t('auth.subSignup')}
        </p>

        {error && <ErrorBanner message={error} />}

        <form onSubmit={handleSubmit} className="auth-card__form" style={{ marginTop: error ? 16 : 0 }}>
          {/* Role picker (signup only) */}
          {!isLogin && (
            <div className="form-group">
              <label className="form-label">{t('auth.iAm')}</label>
              <div className="role-select-group">
                <button
                  type="button"
                  className={`role-option${role === 'PASSENGER' ? ' role-option--selected' : ''}`}
                  onClick={() => setRole('PASSENGER')}
                >
                  <span className="role-option__icon">🧑</span>
                  {t('auth.passenger')}
                </button>
                <button
                  type="button"
                  className={`role-option${role === 'DRIVER' ? ' role-option--selected' : ''}`}
                  onClick={() => setRole('DRIVER')}
                >
                  <span className="role-option__icon">🛺</span>
                  {t('auth.driver')}
                </button>
              </div>
            </div>
          )}

          {!isLogin && (
            <div className="form-group">
              <label className="form-label" htmlFor="auth-name">{t('auth.name')}</label>
              <input
                id="auth-name"
                className="form-control"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('auth.namePh')}
                required
                autoComplete="username"
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="auth-phone">{t('auth.phone')}</label>
            <input
              id="auth-phone"
              className="form-control"
              type="tel"
              inputMode="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder={t('auth.phonePh')}
              required
              autoComplete="tel"
            />
          </div>

          {!isLogin && (
            <div className="form-group">
              <label className="form-label" htmlFor="auth-email">{t('auth.email')}</label>
              <input
                id="auth-email"
                className="form-control"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="auth-password">{t('auth.password')}</label>
            <input
              id="auth-password"
              className="form-control"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={isLogin ? 'current-password' : 'new-password'}
            />
            {isLogin && (
              <Link href="/forgot-password" id="auth-forgot" className="auth-link auth-link--end">
                {t('auth.forgot')}
              </Link>
            )}
          </div>

          <button
            id="auth-submit"
            type="submit"
            className="btn btn--primary btn--full"
            disabled={loading}
            style={{ marginTop: 4 }}
          >
            {loading ? <Spinner /> : (isLogin ? t('auth.submitLogin') : t('auth.submitSignup'))}
          </button>
        </form>

        <p className="auth-card__toggle">
          {isLogin ? t('auth.noAccount') : t('auth.haveAccount')}
          <button id="auth-toggle" onClick={() => { setIsLogin(!isLogin); setError(''); }}>
            {isLogin ? t('auth.signUp') : t('auth.signIn')}
          </button>
        </p>
      </div>
    </div>
  );
}
