import React, { useState, useEffect } from 'react';
import { apiFetch } from '../../lib/apiClient.js';

interface Pt { latitude: number; longitude: number; accuracyM: number | null; recordedAt: string }

/** Office view of a trip's recorded GPS path. Drawn locally as an SVG (the page policy allows no outside map tiles); a link opens the last point in OpenStreetMap in a new tab. */
export function FleetTripTrack({ companyId, tripId }: { companyId: string; tripId: string }) {
  const [pts, setPts] = useState<Pt[] | null>(null);
  const [km, setKm] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await apiFetch(`/api/fleet/trips/${tripId}/track?companyId=${encodeURIComponent(companyId)}`);
        const d = await r.json().catch(() => ({}));
        if (!alive) return;
        if (!r.ok) { setError(d.message || d.error || 'تعذر تحميل المسار'); return; }
        setPts(d.points || []); setKm(Number(d.estimatedKm || 0));
      } catch { if (alive) setError('تعذر تحميل المسار'); }
    })();
    return () => { alive = false; };
  }, [companyId, tripId]);

  if (error) return <div role="alert" className="text-red-300 text-xs">{error}</div>;
  if (!pts) return <div className="text-slate-500 text-xs">جار تحميل المسار...</div>;
  if (pts.length === 0) return <div data-testid="trip-track-empty" className="text-slate-500 text-xs">لا توجد مواقع مسجلة لهذه الرحلة</div>;

  const W = 360, H = 200, pad = 16;
  const lats = pts.map((p) => p.latitude), lngs = pts.map((p) => p.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const midLat = (minLat + maxLat) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
  const s = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
  const X = (lng: number) => pad + ((lng - minLng) * kx - 0) * s + ((W - 2 * pad) - spanX * s) / 2;
  const Y = (lat: number) => H - pad - (lat - minLat) * s - ((H - 2 * pad) - spanY * s) / 2;
  const line = pts.map((p) => `${X(p.longitude).toFixed(1)},${Y(p.latitude).toFixed(1)}`).join(' ');
  const first = pts[0], last = pts[pts.length - 1];
  const osm = `https://www.openstreetmap.org/?mlat=${last.latitude}&mlon=${last.longitude}#map=16/${last.latitude}/${last.longitude}`;
  return (
    <div className="space-y-2" data-testid="trip-track">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: 420 }} className="rounded-xl border border-slate-800 bg-slate-950" role="img" aria-label="مسار الرحلة">
        {pts.length > 1 && <polyline points={line} fill="none" stroke="#818cf8" strokeWidth="2" strokeLinejoin="round" />}
        <circle cx={X(first.longitude)} cy={Y(first.latitude)} r="5" fill="#34d399"><title>البداية</title></circle>
        <circle cx={X(last.longitude)} cy={Y(last.latitude)} r="5" fill="#f87171"><title>آخر موقع</title></circle>
      </svg>
      <div className="text-[11px] text-slate-400 space-y-0.5">
        <div>عدد النقاط: <span className="font-mono tabular-nums">{pts.length}</span> | المسافة التقديرية من النقاط: <span className="font-mono tabular-nums">{km.toLocaleString('en-US')}</span> كم (تقدير فقط، الرسمي هو العداد)</div>
        <div>آخر موقع: <span className="font-mono tabular-nums" dir="ltr">{last.latitude}, {last.longitude}</span> ({new Date(last.recordedAt).toLocaleString('en-GB', { hour12: false })})</div>
        <a href={osm} target="_blank" rel="noopener noreferrer" className="text-indigo-300 underline">فتح آخر موقع في OpenStreetMap</a>
      </div>
    </div>
  );
}
