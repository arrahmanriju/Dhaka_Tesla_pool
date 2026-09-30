'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState, ErrorBanner, ErrorState, LoadingScreen, Spinner } from '@/components/UI';
import { passengerApi, qrApi, type QRSession, type QRVehiclePreview } from '@/lib/api';
import { usePreferences, useFormatApiError } from '@/lib/preferences';

/** A QR sticker holds just the vehicle code; a link with ?code=... is understood too. */
export function extractVehicleCode(raw: string): string {
  const fromLink = raw.match(/[?&]code=([^&\s]+)/i);
  return (fromLink ? decodeURIComponent(fromLink[1]!) : raw).trim();
}

type Detector = { detect: (v: HTMLVideoElement) => Promise<{ rawValue: string }[]> };
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

/**
 * Street rides for drivers with no smartphone. The driver does nothing at all: the passenger scans the
 * sticker (or types the code) and joins here. The ride itself (route, fare, cash, the others as "Passenger N",
 * and "I've arrived") is then shown on the Active Ride page with the same card as an app ride. Payment is always cash.
 */
export function StreetRideTab({
  initialCode = '',
  onJoined,
  onViewActive,
}: {
  initialCode?: string;
  /** Called once the passenger has joined: the ride itself is shown on the Active Ride page */
  onJoined: () => void;
  onViewActive: () => void;
}) {
  const { t } = usePreferences();
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

  // This page only joins a ride. A ride the passenger is on is shown on the Active Ride page, like an app ride.
  const onARide = session?.status === 'OPEN';

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
          {onARide ? (
            // Already on a street ride: point to it instead of offering a second one
            <div className="info-banner" id="street-already" role="status" style={{ flexWrap: 'wrap', gap: 12 }}>
              🛺 {t('qr.alreadyRiding')}
              <button type="button" id="street-view-active" className="btn btn--secondary btn--sm" onClick={onViewActive}>
                {t('qr.viewActive')}
              </button>
            </div>
          ) : (
            <>
              {/* No ride in progress (never joined, or the last one has ended and moved to History): the normal
                  "scan or enter a vehicle code" state, ready for a new ride */}
              <JoinForm initialCode={initialCode} onJoined={onJoined} />
              <EmptyState icon="🛺" title={t('qr.emptyTitle')} description={t('qr.emptyDesc')} />
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Joining ───────────────────────────────────────────────────────────────
function JoinForm({ initialCode, onJoined }: { initialCode: string; onJoined: (s: QRSession) => void }) {
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
    <div className="card">
      <div className="card__body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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
