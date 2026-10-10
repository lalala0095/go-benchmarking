export const MINUS = '−';

export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Milliseconds: "412 ms", "4.2 ms", "1.83 s". */
export function fmtMs(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  if (Math.abs(v) >= 1000) return `${(v / 1000).toFixed(2)} s`;
  if (Math.abs(v) >= 100) return `${Math.round(v)} ms`;
  if (Math.abs(v) >= 10) return `${v.toFixed(1)} ms`;
  return `${v.toFixed(2)} ms`;
}

export function fmtNum(v: number | null | undefined, digits = 0): string {
  if (!isNum(v)) return '—';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact: 12.4k, 1.2M. */
export function fmtCompact(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  if (a >= 100) return Math.round(v).toLocaleString('en-US');
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (!isNum(v)) return '—';
  return `${v.toFixed(digits)}%`;
}

export function fmtMB(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  return v >= 1024 ? `${(v / 1024).toFixed(2)} GB` : `${v.toFixed(v >= 100 ? 0 : 1)} MB`;
}

export function fmtBytes(v: number | null | undefined): string {
  if (!isNum(v)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = v;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fmtTime(iso: string | number): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDuration(startIso: string | null | undefined, endIso: string | null | undefined): string {
  if (!startIso || !endIso) return '—';
  const s = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
  if (!Number.isFinite(s) || s < 0) return '—';
  if (s < 60) return `${s.toFixed(0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

export function median(values: (number | null | undefined)[]): number | null {
  const v = values.filter(isNum).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function mean(values: (number | null | undefined)[]): number | null {
  const v = values.filter(isNum);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
