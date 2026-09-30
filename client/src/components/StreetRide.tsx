'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorBanner, ErrorState, LoadingScreen, Spinner } from '@/components/UI';
import { passengerApi, qrApi, type QRSession, type QRVehiclePreview } from '@/lib/api';
import { usePreferences, useFormatApiError } from '@/lib/preferences';
import type { TranslationKey } from '@/lib/translations';

/** How often an open street ride re-reads itself (plain polling, no websockets). */
export const STREET_POLL_MS = 8000;

/** A QR sticker holds just the vehicle code; a link with ?code=... is understood too. */
export function extractVehicleCode(raw: string): string {
  const fromLink = raw.match(/[?&]code=([^&\s]+)/i);
  return (fromLink ? decodeURIComponent(fromLink[1]!) : raw).trim();
}

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/**
 * Street rides for drivers with no smartphone. The driver does nothing at all: the passenger scans the
 * sticker (or types the code), joins, and taps "I've arrived" when they get off. Others in the car
 * appear only as "Passenger 1", "Passenger 2". Payment is always cash.
 */
export function StreetRideTab({ initialCode = '' }: { initialCode?: string }) {
  const { t, tz, tp } = usePreferences();
  const formatError = useFormatApiError();

  const [session, setSession] = useState<QRSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  const load = useCallback(async (silent = false) => {
    if (!silent) { setLoading(true); setLoadError(''); }
    try {
      const res = await qrApi.mine();
      setSession(res.session);
      setLoadError('');
    } catch (err) {
      if (!silent) setLoadError(formatError(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [formatError]);

  useEffect(() => {
    const first = setTimeout(() => load(), 0);
    return () => clearTimeout(first);
  }, [load]);

  // While a ride is open it re-reads itself, so people joining or leaving (and an automatic close) show up
  const open = session?.status === 'OPEN';
  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => { if (!document.hidden) load(true); }, STREET_POLL_MS);
    return () => clearInterval(timer);
  }, [open, load]);

  if (loading) return <LoadingScreen label={t('loading.qr')} />;

  return (
    <div className="animate-in">
      <div className="section-header">
        <div>
          <h1 className="section-title">{t('qr.title')}</h1>
          <p className="section-desc">{t('qr.desc')}</p>
        </div>
      </div>

      {loadError ? (
        <ErrorState message={loadError} onRetry={() => load()} />
      ) : (
        <>
          {session && <SessionCard session={session} onChange={setSession} tz={tz} t={t} tp={tp} formatError={formatError} />}
          {!open && <JoinForm initialCode={initialCode} onJoined={setSession} hasEnded={!!session} />}
          {!session && !open && (
            <EmptyState icon="🛺" title={t('qr.emptyTitle')} description={t('qr.emptyDesc')} />
          )}
        </>
      )}
    </div>
  );
}

// ─── Joining ───────────────────────────────────────────────────────────────
function JoinForm({ initialCode, onJoined, hasEnded }: { initialCode: string; onJoined: (s: QRSession) => void; hasEnded: boolean }) {
  const { t, tz } = usePreferences();
  const formatError = useFormatApiError();
  const [code, setCode] = useState(initialCode);
  const [preview, setPreview] = useState<QRVehiclePreview | null>(null);
  const [finding, setFinding] = useState(false);
  const [zones, setZones] = useState<string[]>([]);
  const [pickup, setPickup] = useState('');
  const [destination, setDestination] = useState('');
  const [seats, setSeats] = useState(1);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  // scanning
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => { passengerApi.getRideOptions().then((o) => setZones(o.zones)).catch(() => { /* the server validates zones anyway */ }); }, []);

  const find = useCallback(async (value: string) => {
    const wanted = extractVehicleCode(value);
    if (!wanted) return;
    setFinding(true); setError(''); setPreview(null);
    try {
      setPreview(await qrApi.preview(wanted));
      setCode(wanted);
    } catch (err) {
      setError(formatError(err)); // e.g. "We couldn't find a vehicle with that code…"
    } finally {
      setFinding(false);
    }
  }, [formatError]);

  // A code passed in the address (?code=...) is looked up straight away
  useEffect(() => { if (initialCode) { const timer = setTimeout(() => find(initialCode), 0); return () => clearTimeout(timer); } }, [initialCode, find]);

  const stopScan = useCallback(() => {
    if (scanTimer.current) clearInterval(scanTimer.current);
    scanTimer.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);
  useEffect(() => stopScan, [stopScan]);

  const startScan = async () => {
    setError('');
    const Detector = (window as unknown as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;
    if (!Detector || !navigator.mediaDevices?.getUserMedia) { setError(t('qr.scanUnsupported')); return; }
    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      setScanning(true);
      const video = videoRef.current;
      if (!video) return;
      video.srcObject = streamRef.current;
      await video.play();
      const detector = new Detector({ formats: ['qr_code'] });
      scanTimer.current = setInterval(async () => {
        try {
          const found = await detector.detect(video);
          if (found[0]) { stopScan(); find(found[0].rawValue); }
        } catch { /* keep trying */ }
      }, 400);
    } catch {
      stopScan();
      setError(t('qr.cameraDenied'));
    }
  };

  const join = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!preview || joining) return;
    setJoining(true); setError('');
    try {
      const res = await qrApi.join({
        vehicleCode: preview.vehicleCode,
        pickupZone: pickup,
        destinationZone: destination,
        seatCount: seats,
        // the ride the passenger was shown: if it ended in the meantime the server says so instead of opening another
        ...(preview.session ? { sessionId: preview.session.id } : {}),
      });
      onJoined(res.session);
    } catch (err) {
      setError(formatError(err));
      find(preview.vehicleCode); // the ride or the free seats may have changed
    } finally {
      setJoining(false);
    }
  };

  const full = !!preview && preview.vehicle.seatsFree < 1;

  return (
    <div className="card" style={{ marginTop: hasEnded ? 16 : 0 }}>
      <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {hasEnded && <h2 className="card__title">{t('qr.new')}</h2>}
        {error && <ErrorBanner message={error} />}

        <form onSubmit={(e) => { e.preventDefault(); find(code); }} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-group">
            <label className="form-label" htmlFor="qr-code">{t('qr.codeLabel')}</label>
            <input
              id="qr-code"
              className="form-control"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder={t('qr.codePh')}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
            />
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button id="qr-find" type="submit" className="btn btn--primary btn--sm" disabled={finding || !code.trim()}>
              {finding ? <><Spinner /> {t('qr.finding')}</> : t('qr.find')}
            </button>
            {scanning ? (
              <button type="button" className="btn btn--ghost btn--sm" onClick={stopScan}>{t('qr.scanStop')}</button>
            ) : (
              <button id="qr-scan" type="button" className="btn btn--secondary btn--sm" onClick={startScan}>📷 {t('qr.scan')}</button>
            )}
          </div>
          {scanning && <p className="form-hint">{t('qr.scanning')}</p>}
          <video ref={videoRef} playsInline muted style={{ display: scanning ? 'block' : 'none', width: '100%', maxWidth: 320, borderRadius: 8 }} />
        </form>

        {preview && (
          <form onSubmit={join} style={{ display: 'flex', flexDirection: 'column', gap: 16 }} id="qr-join-form">
            <div className="info-banner" id="qr-vehicle" role="status">
              🛺 {t('qr.vehicle', { name: preview.vehicle.nickname, free: preview.vehicle.seatsFree, total: preview.vehicle.seatCapacity })}
              <br />
              {preview.session ? t('qr.openRide', { n: preview.session.passengerCount }) : t('qr.newRide')}
            </div>
            {full && <ErrorBanner message={t('qr.full')} />}

            <div className="form-group">
              <label className="form-label" htmlFor="qr-pickup">{t('p.req.pickup')}</label>
              <select id="qr-pickup" className="form-control" value={pickup} required onChange={(e) => { setPickup(e.target.value); if (e.target.value === destination) setDestination(''); }}>
                <option value="">{t('p.req.pickupPh')}</option>
                {zones.map((z) => <option key={z} value={z}>{tz(z)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="qr-destination">{t('p.req.dest')}</label>
              <select id="qr-destination" className="form-control" value={destination} required onChange={(e) => setDestination(e.target.value)}>
                <option value="">{t('p.req.destPh')}</option>
                {zones.filter((z) => z !== pickup).map((z) => <option key={z} value={z}>{tz(z)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="qr-seats">{t('p.req.seats')}</label>
              <select id="qr-seats" className="form-control" value={seats} onChange={(e) => setSeats(Number(e.target.value))}>
                {[1, 2, 3].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <p className="form-hint" id="qr-cash-note">💵 {t('qr.cashOnly')}</p>
            <button id="qr-join" type="submit" className="btn btn--primary btn--full" disabled={joining || full || !pickup || !destination}>
              {joining ? <><Spinner /> {t('qr.joining')}</> : t('qr.join')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

// ─── The ride ──────────────────────────────────────────────────────────────
type Translate = ReturnType<typeof usePreferences>['t'];

function SessionCard({
  session,
  onChange,
  tz,
  t,
  tp,
  formatError,
}: {
  session: QRSession;
  onChange: (s: QRSession) => void;
  tz: (zone: string) => string;
  t: Translate;
  tp: ReturnType<typeof usePreferences>['tp'];
  formatError: (err: unknown) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { you } = session;
  const riding = session.status === 'OPEN' && you.status === 'RIDING';

  const arrived = async () => {
    setBusy(true); setError('');
    try {
      onChange((await qrApi.arrived(session.id)).session);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="ride-card ride-status" id={`street-ride-${session.id}`} data-status={session.status}>
      <div className="ride-card__route">
        <span className="ride-card__zone">{tz(you.pickupZone)}</span>
        <span className="ride-card__arrow">→</span>
        <span className="ride-card__zone">{tz(you.destinationZone)}</span>
        <span className={`badge badge--${you.status === 'RIDING' ? 'started' : 'completed'}`}>{t(`qr.status.${you.status}` as TranslationKey)}</span>
      </div>
      {session.vehicle.nickname && <p className="form-hint">🛺 {session.vehicle.nickname} · {session.vehicle.vehicleCode}</p>}

      {session.status === 'CLOSED' && (
        <div className="info-banner" id="street-closed" role="status">
          {session.closeReason === 'TIMEOUT'
            ? t('qr.closed.TIMEOUT', { min: session.autoCloseAfterMinutes })
            : t('qr.closed.ALL_ARRIVED')}
          {you.status === 'AUTO_COMPLETED' && <><br />{t('qr.autoNote')}</>}
        </div>
      )}

      {/* Everyone in the car, as Passenger N only */}
      <section className="ride-block" id="street-passengers" aria-label={t('qr.others')}>
        <h3 className="ride-block__title">{t('qr.others')}</h3>
        <div className="ride-block__line">{t('qr.youAre', { n: you.passengerNumber })}</div>
        {session.passengers.map((p) => (
          <div key={p.label} className="ride-block__line">
            {p.label}{p.isYou ? ` (${t('qr.youAre', { n: you.passengerNumber }).toLowerCase()})` : ''}: {t(`qr.status.${p.status}` as TranslationKey)}
          </div>
        ))}
      </section>

      <div className="ride-card__meta" style={{ marginTop: 16 }}>
        <span className="ride-card__meta-item">{tp('seatUnit', you.seatCount)}</span>
        <span className="ride-card__meta-item" id="street-fare">
          {you.fareFinal ? t('qr.fareFinal') : t('qr.fareEstimate')} <strong>৳{you.fare}</strong>
        </span>
      </div>

      {you.fareBreakdown.segments.some((s) => s.distanceKm > 0) && (
        <section className="ride-block" id="street-breakdown" aria-label={t('rs.bill.title')}>
          <h3 className="ride-block__title">{t('rs.bill.title')}</h3>
          <div className="ride-block__line">{t('rs.bill.base')}: ৳{you.fareBreakdown.baseCharge}</div>
          {you.fareBreakdown.segments.filter((s) => s.distanceKm > 0).map((s, i) => (
            <div key={i} className="ride-block__line">
              {t('rs.bill.segment', { km: s.distanceKm, n: s.passengers, distance: s.distanceCharge, rate: s.ratePercent })} = ৳{s.charge}
            </div>
          ))}
          {(you.poolDiscount ?? 0) > 0 && <div className="ride-block__line">{t('rs.bill.saved', { saved: you.poolDiscount ?? 0 })}</div>}
        </section>
      )}

      {/* Cash to the driver: the wallet is never used for street rides */}
      {you.payment.status === 'CASH_DUE' && (
        <div className="ride-block__line" id="street-payment" style={{ marginTop: 8 }}>
          💵 {t('qr.payCash', { amount: you.payment.amount ?? you.fare ?? 0 })}
        </div>
      )}

      {error && <ErrorBanner message={error} />}
      {riding && (
        <div className="ride-card__footer" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
          <p className="form-hint">{t('qr.arrivedHelp')}</p>
          <button id="street-arrived" className="btn btn--success" onClick={arrived} disabled={busy}>
            {busy ? <><Spinner /> {t('qr.arriving')}</> : `✅ ${t('qr.arrived')}`}
          </button>
        </div>
      )}
    </article>
  );
}
