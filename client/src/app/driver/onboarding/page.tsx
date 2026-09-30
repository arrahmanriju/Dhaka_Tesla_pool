'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AppNav } from '@/components/AppNav';
import { LoadingScreen, ErrorBanner, ErrorState, Spinner } from '@/components/UI';
import { driverApi, assetUrl, ApiError, type OnboardingProfile, type OnboardingState } from '@/lib/api';
import { getUser } from '@/lib/auth';
import { toAsciiDigits } from '@/lib/phone';
import { usePreferences, useFormatApiError } from '@/lib/preferences';
import type { TranslationKey } from '@/lib/translations';

const SEAT_OPTIONS = [1, 2, 3];
const NID_LENGTHS = [10, 13, 17];
const MAX_PICTURE_BYTES = 2 * 1024 * 1024; // 2 MB — same limit the server enforces

type Field = 'nickname' | 'seatCapacity' | 'homeZone' | 'nid' | 'profilePicture';
type Errors = Partial<Record<Field, TranslationKey>>;

const readAsDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });

export default function DriverOnboardingPage() {
  const router = useRouter();
  const { t, tp, tz } = usePreferences();
  const formatError = useFormatApiError();
  const [loadTry, setLoadTry] = useState(0); // bumped by the retry button

  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadError, setLoadError] = useState('');
  const [done, setDone] = useState<OnboardingProfile | null>(null); // set right after submitting

  const [nickname, setNickname] = useState('');
  const [seatCapacity, setSeatCapacity] = useState('');
  const [homeZone, setHomeZone] = useState('');
  const [nid, setNid] = useState('');
  const [picture, setPicture] = useState<{ dataUrl: string; previewUrl: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<TranslationKey | string>('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const u = getUser();
    if (!u || u.role !== 'DRIVER') { router.replace('/auth'); return; }
    driverApi.getOnboarding()
      .then((s) => {
        setState(s);
        // A driver who registered a vehicle before onboarding existed gets it prefilled.
        if (s.existingVehicle) {
          setNickname(s.existingVehicle.nickname);
          if (SEAT_OPTIONS.includes(s.existingVehicle.seatCapacity)) setSeatCapacity(String(s.existingVehicle.seatCapacity));
        }
      })
      .catch((err) => setLoadError(formatError(err)));
  }, [router, loadTry, formatError]);

  // Free the preview's object URL when it is replaced or the page closes.
  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.previewUrl); }, [picture]);

  const clearError = (field: Field) => setErrors((e) => ({ ...e, [field]: undefined }));

  const choosePicture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // lets the same file be picked again after "Remove"
    if (!file) return;
    if (file.type !== 'image/jpeg' && file.type !== 'image/png') {
      setErrors((x) => ({ ...x, profilePicture: 'ob.err.photoType' })); return;
    }
    if (file.size > MAX_PICTURE_BYTES) {
      setErrors((x) => ({ ...x, profilePicture: 'ob.err.photoSize' })); return;
    }
    try {
      setPicture({ dataUrl: await readAsDataUrl(file), previewUrl: URL.createObjectURL(file) });
      clearError('profilePicture');
    } catch {
      setErrors((x) => ({ ...x, profilePicture: 'ob.err.photoType' }));
    }
  };

  const validate = (): Errors => {
    const found: Errors = {};
    const nick = nickname.trim().replace(/\s+/g, ' ');
    if (!/^[\p{L}\p{N}][\p{L}\p{M}\p{N} '\-_.]{1,29}$/u.test(nick)) found.nickname = 'ob.err.nickname';
    if (!SEAT_OPTIONS.includes(Number(seatCapacity))) found.seatCapacity = 'ob.err.seats';
    if (!homeZone || !state?.zones.includes(homeZone)) found.homeZone = 'ob.err.zone';
    const digits = toAsciiDigits(nid.trim());
    if (!digits) found.nid = 'ob.err.nidRequired';
    else if (!/^\d+$/.test(digits)) found.nid = 'ob.err.nidDigits';
    else if (!NID_LENGTHS.includes(digits.length)) found.nid = 'ob.err.nidLength';
    return found;
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    const found = validate();
    setErrors(found);
    if (Object.keys(found).length > 0) { setFormError('ob.err.fix'); return; }

    setSaving(true);
    try {
      const res = await driverApi.submitOnboarding({
        nickname: nickname.trim().replace(/\s+/g, ' '),
        seatCapacity: Number(seatCapacity),
        homeZone,
        nid: toAsciiDigits(nid.trim()),
        ...(picture ? { profilePicture: picture.dataUrl } : {}),
      });
      setDone(res.profile);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'NID_TAKEN') {
        setErrors({ nid: 'ob.err.nidTaken' }); setFormError('ob.err.fix');
      } else if (err instanceof ApiError && err.code === 'SEATS_IN_USE') {
        setErrors({ seatCapacity: 'ob.err.seatsInUse' }); setFormError('ob.err.fix');
      } else if (err instanceof ApiError && err.code === 'ALREADY_ONBOARDED') {
        window.location.reload(); // another tab finished it — show the summary
      } else if (err instanceof ApiError && err.code === 'VALIDATION' && err.fields) {
        setFormError(err.message);
      } else {
        setFormError(formatError(err)); // plain words, never a status code
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <div className="dashboard">
        <AppNav />
        <div className="dashboard__body">
          <ErrorState message={loadError} onRetry={() => { setLoadError(''); setLoadTry((n) => n + 1); }} />
        </div>
      </div>
    );
  }
  if (!state) return <LoadingScreen />;

  const profile = done ?? state.profile;
  const fieldProps = (field: Field, described?: string) => ({
    'aria-invalid': errors[field] ? (true as const) : undefined,
    'aria-describedby': [errors[field] ? `ob-${field}-error` : '', described ?? ''].filter(Boolean).join(' ') || undefined,
  });
  const fieldError = (field: Field) =>
    errors[field] ? <span className="field-error" id={`ob-${field}-error`} role="alert">{t(errors[field]!)}</span> : null;

  // ── Finished: show the Tesla ID (right after submitting, and on later visits) ──
  if (profile) {
    return (
      <div className="dashboard">
        <AppNav />
        <div className="dashboard__body animate-in">
          <div className="section-header">
            <div>
              <h1 className="section-title">{done ? t('ob.doneTitle') : t('ob.alreadyTitle')}</h1>
              {done && <p className="section-desc">{t('ob.doneDesc')}</p>}
            </div>
          </div>

          <div className="card">
            <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
              <div className="photo-row">
                {profile.profilePictureUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className="avatar" src={assetUrl(profile.profilePictureUrl)} alt="" />
                ) : (
                  <div className="avatar" aria-hidden="true">🛺</div>
                )}
                <div>
                  <div className="tesla-id" id="tesla-id" role="status">{t('ob.yourId', { code: profile.driverCode })}</div>
                  <div className="section-desc">{state.driver.name}</div>
                </div>
              </div>

              <dl className="summary-list">
                <div><dt>{t('ob.nickname')}</dt><dd>{profile.nickname ?? '—'}</dd></div>
                <div><dt>{t('ob.seats')}</dt><dd>{profile.seatCapacity ? tp('seats', profile.seatCapacity) : '—'}</dd></div>
                <div><dt>{t('ob.homeZone')}</dt><dd>{tz(profile.homeZone)}</dd></div>
                <div><dt>{t('ob.nid')}</dt><dd dir="ltr" style={{ textAlign: 'start' }}>{profile.nidMasked}</dd></div>
              </dl>

              <Link href="/driver" id="ob-to-dashboard" className="btn btn--primary">{t('ob.toDashboard')}</Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── The form ──
  return (
    <div className="dashboard">
      <AppNav />
      <div className="dashboard__body animate-in">
        <div className="section-header">
          <div>
            <h1 className="section-title">{t('ob.title')}</h1>
            <p className="section-desc">{t('ob.subtitle')}</p>
          </div>
          <Link href="/driver" className="btn btn--ghost btn--sm">{t('ob.back')}</Link>
        </div>

        <form className="card" onSubmit={submit} noValidate>
          <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {formError && <ErrorBanner message={formError.startsWith('ob.') ? t(formError as TranslationKey) : formError} />}

            {/* Already given at signup: shown, not asked again */}
            <section className="form-section" aria-labelledby="ob-details">
              <div>
                <h2 className="form-section__title" id="ob-details">{t('ob.yourDetails')}</h2>
                <p className="form-hint">{t('ob.readOnlyHint')}</p>
              </div>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="ob-name">{t('auth.name')}</label>
                  <input id="ob-name" className="form-control" value={state.driver.name} readOnly />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="ob-phone">{t('auth.phone')}</label>
                  <input id="ob-phone" className="form-control" value={state.driver.phone ?? '—'} readOnly dir="ltr" />
                </div>
              </div>
            </section>

            <section className="form-section" aria-labelledby="ob-vehicle">
              <h2 className="form-section__title" id="ob-vehicle">{t('ob.vehicleSection')}</h2>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="ob-nickname">{t('ob.nickname')} *</label>
                  <input
                    id="ob-nickname"
                    className="form-control"
                    value={nickname}
                    onChange={(e) => { setNickname(e.target.value); clearError('nickname'); }}
                    placeholder={t('ob.nicknamePh')}
                    maxLength={30}
                    autoComplete="off"
                    required
                    {...fieldProps('nickname')}
                  />
                  {fieldError('nickname')}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="ob-seats">{t('ob.seats')} *</label>
                  <select
                    id="ob-seats"
                    className="form-control"
                    value={seatCapacity}
                    onChange={(e) => { setSeatCapacity(e.target.value); clearError('seatCapacity'); }}
                    required
                    {...fieldProps('seatCapacity', 'ob-seats-hint')}
                  >
                    <option value="" disabled>—</option>
                    {SEAT_OPTIONS.map((n) => <option key={n} value={n}>{tp('seats', n)}</option>)}
                  </select>
                  <span className="form-hint" id="ob-seats-hint">{t('ob.seatsHint')}</span>
                  {fieldError('seatCapacity')}
                </div>

                <div className="form-group">
                  <label className="form-label" htmlFor="ob-zone">{t('ob.homeZone')} *</label>
                  <select
                    id="ob-zone"
                    className="form-control"
                    value={homeZone}
                    onChange={(e) => { setHomeZone(e.target.value); clearError('homeZone'); }}
                    required
                    {...fieldProps('homeZone')}
                  >
                    <option value="">{t('ob.homeZonePh')}</option>
                    {state.zones.map((z) => <option key={z} value={z}>{tz(z)}</option>)}
                  </select>
                  {fieldError('homeZone')}
                </div>
              </div>
            </section>

            <section className="form-section" aria-labelledby="ob-identity">
              <h2 className="form-section__title" id="ob-identity">{t('ob.identity')}</h2>
              <div className="form-grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="ob-nid">{t('ob.nid')} *</label>
                  <input
                    id="ob-nid"
                    className="form-control"
                    value={nid}
                    onChange={(e) => { setNid(toAsciiDigits(e.target.value)); clearError('nid'); }}
                    inputMode="numeric"
                    maxLength={20}
                    placeholder={t('ob.nidPh')}
                    autoComplete="off"
                    dir="ltr"
                    required
                    {...fieldProps('nid', 'ob-nid-hint')}
                  />
                  <span className="form-hint" id="ob-nid-hint">🔒 {t('ob.nidHint')}</span>
                  {fieldError('nid')}
                </div>

                <div className="form-group">
                  <span className="form-label" id="ob-photo-label">{t('ob.photo')}</span>
                  <div className="photo-row">
                    {picture ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img className="avatar" src={picture.previewUrl} alt={t('ob.photoAlt')} />
                    ) : (
                      <div className="avatar" aria-hidden="true">🛺</div>
                    )}
                    <input
                      ref={fileInput}
                      id="ob-photo"
                      type="file"
                      accept="image/png,image/jpeg"
                      onChange={choosePicture}
                      aria-labelledby="ob-photo-label"
                      aria-describedby="ob-photo-hint"
                    />
                    <button type="button" className="btn btn--secondary btn--sm" onClick={() => fileInput.current?.click()}>
                      {picture ? t('ob.photoChange') : t('ob.photoChoose')}
                    </button>
                    {picture && (
                      <button type="button" className="btn btn--ghost btn--sm" id="ob-photo-remove" onClick={() => setPicture(null)}>
                        {t('ob.photoRemove')}
                      </button>
                    )}
                  </div>
                  <span className="form-hint" id="ob-photo-hint">{t('ob.photoHint')}</span>
                  {fieldError('profilePicture')}
                </div>
              </div>
            </section>

            <button id="ob-submit" type="submit" className="btn btn--primary btn--full" disabled={saving}>
              {saving ? <><Spinner /> {t('ob.submitting')}</> : t('ob.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
