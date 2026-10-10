// Kubernetes resource.Quantity parsing (subset sufficient for cpu/memory).
const SUFFIX: Record<string, number> = {
  n: 1e-9, u: 1e-6, m: 1e-3, '': 1,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18,
  Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4, Pi: 1024 ** 5, Ei: 1024 ** 6,
};

export function parseQuantity(q: string | number | undefined | null): number | null {
  if (q === undefined || q === null) return null;
  if (typeof q === 'number') return q;
  const m = /^([+-]?[0-9.]+(?:[eE][+-]?[0-9]+)?)([a-zA-Z]*)$/.exec(q.trim());
  if (!m) return null;
  const mult = SUFFIX[m[2]];
  if (mult === undefined) return null;
  return Number(m[1]) * mult;
}
