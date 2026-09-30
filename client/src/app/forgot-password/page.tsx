'use client';
import { useState } from 'react';
import Link from 'next/link';
import { authApi, ApiError } from '@/lib/api';
import { normalizePhone, toAsciiDigits } from '@/lib/phone';
import { usePreferences, useFormatApiError } from '@/lib/preferences';
import { Spinner, ErrorBanner, SuccessBanner } from '@/components/UI';
import { PreferenceControls } from '@/components/PreferenceControls';
import type { TranslationKey } from '@/lib/translations';

type Step = 'phone' | 'reset' | 'done';

// Same rules as the server (min 8 chars, a letter and a number).
const isStrongPassword = (p: string) => p.length >= 8 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);

export default function ForgotPasswordPage() {
  const { t } = usePreferences();
  const formatError = useFormatApiError();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // A translation key (follows the language switcher) or raw server text.
  const [error, setError] = useState<{ key?: TranslationKey; raw?: string } | null>(null);

  const normalizedPhone = normalizePhone(phone);

  const requestCode = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (!normalizedPhone) { setError({ key: 'auth.phoneInvalid' }); return; }
    setLoading(true);
    try {
      const res = await authApi.forgotPassword(normalizedPhone);
      setDevCode(res.devCode ?? null);
      setCode('');
      setStep('reset');
    } catch (err) {
      setError({ raw: formatError(err) });
    } finally {
      setLoading(false);
    }
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleanCode = toAsciiDigits(code).trim();
    if (!/^\d{6}$/.test(cleanCode)) { setError({ key: 'fp.codeMissing' }); return; }
    if (!isStrongPassword(password)) { setError({ key: 'fp.passwordHint' }); return; }
    if (password !== confirm) { setError({ key: 'fp.mismatch' }); return; }
    setLoading(true);
    try {
      await authApi.resetPassword(normalizedPhone!, cleanCode, password);
      setStep('done');
    } catch (err) {
      // The server answers every wrong/expired/used code with the same 400.
      if (err instanceof ApiError && err.status === 400 && err.message === 'Invalid or expired code.') {
        setError({ key: 'fp.invalidCode' });
      } else {
        setError({ raw: formatError(err) });
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <PreferenceControls floating />
      <div className="auth-card animate-in">
        <div className="auth-card__brand">
          <div className="auth-card__brand-icon">🛺</div>
          <span className="auth-card__brand-name">{t('app.name')}</span>
        </div>

        <h1 className="auth-card__title">{t('fp.title')}</h1>
        <p className="auth-card__sub">
          {step === 'phone' && t('fp.subPhone')}
          {step === 'reset' && t('fp.subReset', { phone: normalizedPhone ?? phone })}
        </p>

        {error && <ErrorBanner message={error.key ? t(error.key) : error.raw ?? ''} />}

        {step === 'phone' && (
          <form onSubmit={requestCode} className="auth-card__form" style={{ marginTop: error ? 16 : 0 }}>
            <div className="form-group">
              <label className="form-label" htmlFor="fp-phone">{t('auth.phone')}</label>
              <input
                id="fp-phone"
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
            <button id="fp-send" type="submit" className="btn btn--primary btn--full" disabled={loading}>
              {loading ? <Spinner /> : t('fp.sendCode')}
            </button>
          </form>
        )}

        {step === 'reset' && (
          <form onSubmit={submitReset} className="auth-card__form" style={{ marginTop: error ? 16 : 0 }}>
            <div className="success-banner">{t('fp.sent')}</div>
            {devCode && (
              <div className="success-banner" id="fp-dev-code" role="status">
                {t('fp.devCode', { code: devCode })}
              </div>
            )}

            <div className="form-group">
              <label className="form-label" htmlFor="fp-code">{t('fp.code')}</label>
              <input
                id="fp-code"
                className="form-control code-input"
                type="text"
                inputMode="numeric"
                pattern="[0-9০-৯]*"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder={t('fp.codePh')}
                required
                autoComplete="one-time-code"
              />
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="fp-password">{t('fp.newPassword')}</label>
              <input
                id="fp-password"
                className="form-control"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="new-password"
                aria-describedby="fp-password-hint"
              />
              <span className="form-hint" id="fp-password-hint">{t('fp.passwordHint')}</span>
            </div>

            <div className="form-group">
              <label className="form-label" htmlFor="fp-confirm">{t('fp.confirm')}</label>
              <input
                id="fp-confirm"
                className="form-control"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
                autoComplete="new-password"
              />
            </div>

            <button id="fp-submit" type="submit" className="btn btn--primary btn--full" disabled={loading}>
              {loading ? <Spinner /> : t('fp.reset')}
            </button>

            <div className="auth-card__toggle" style={{ marginTop: 0, display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <button type="button" id="fp-resend" onClick={() => requestCode()} disabled={loading} style={{ marginLeft: 0 }}>
                {t('fp.resend')}
              </button>
              <button type="button" id="fp-change" onClick={() => { setStep('phone'); setError(null); }} style={{ marginLeft: 0 }}>
                {t('fp.changeNumber')}
              </button>
            </div>
          </form>
        )}

        {step === 'done' && (
          <div className="auth-card__form">
            <SuccessBanner message={t('fp.done')} />
            <Link href="/auth" id="fp-to-signin" className="btn btn--primary btn--full">
              {t('fp.toSignIn')}
            </Link>
          </div>
        )}

        {step !== 'done' && (
          <p className="auth-card__toggle">
            <Link href="/auth" id="fp-back" className="auth-link">{t('fp.toSignIn')}</Link>
          </p>
        )}
      </div>
    </div>
  );
}
