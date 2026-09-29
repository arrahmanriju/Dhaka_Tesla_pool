'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { authApi, type Role } from '@/lib/api';
import { saveAuth } from '@/lib/auth';
import { Spinner, ErrorBanner } from '@/components/UI';

export default function AuthPage() {
  const [isLogin, setIsLogin] = useState(true);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('PASSENGER');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = isLogin
        ? await authApi.login(email, password)
        : await authApi.signup(name, email, password, role);

      saveAuth(data.token, data.user);
      router.push(data.user.role === 'DRIVER' ? '/driver' : '/passenger');
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card animate-in">
        {/* Brand */}
        <div className="auth-card__brand">
          <div className="auth-card__brand-icon">⚡</div>
          <span className="auth-card__brand-name">Tesla Pool Dhaka</span>
        </div>

        <h1 className="auth-card__title">
          {isLogin ? 'Welcome back' : 'Create an account'}
        </h1>
        <p className="auth-card__sub">
          {isLogin
            ? 'Sign in to manage your rides.'
            : 'Join the Dhaka EV pool network.'}
        </p>

        {error && <ErrorBanner message={error} />}

        <form onSubmit={handleSubmit} className="auth-card__form" style={{ marginTop: error ? 16 : 0 }}>
          {/* Role picker (signup only) */}
          {!isLogin && (
            <div className="form-group">
              <label className="form-label">I am a…</label>
              <div className="role-select-group">
                <button
                  type="button"
                  className={`role-option${role === 'PASSENGER' ? ' role-option--selected' : ''}`}
                  onClick={() => setRole('PASSENGER')}
                >
                  <span className="role-option__icon">🧑</span>
                  Passenger
                </button>
                <button
                  type="button"
                  className={`role-option${role === 'DRIVER' ? ' role-option--selected' : ''}`}
                  onClick={() => setRole('DRIVER')}
                >
                  <span className="role-option__icon">🚗</span>
                  Driver
                </button>
              </div>
            </div>
          )}

          {!isLogin && (
            <div className="form-group">
              <label className="form-label" htmlFor="auth-name">Name</label>
              <input
                id="auth-name"
                className="form-control"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Nusrat"
                required
                autoComplete="username"
              />
            </div>
          )}

          <div className="form-group">
            <label className="form-label" htmlFor="auth-email">Email</label>
            <input
              id="auth-email"
              className="form-control"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
            />
          </div>

          <div className="form-group">
            <label className="form-label" htmlFor="auth-password">Password</label>
            <input
              id="auth-password"
              className="form-control"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={isLogin ? 'current-password' : 'new-password'}
            />
          </div>

          <button
            id="auth-submit"
            type="submit"
            className="btn btn--primary btn--full"
            disabled={loading}
            style={{ marginTop: 4 }}
          >
            {loading ? <Spinner /> : (isLogin ? 'Sign in' : 'Create account')}
          </button>
        </form>

        <p className="auth-card__toggle">
          {isLogin ? "Don't have an account?" : 'Already have an account?'}
          <button id="auth-toggle" onClick={() => { setIsLogin(!isLogin); setError(''); }}>
            {isLogin ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
