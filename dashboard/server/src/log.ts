// Minimal structured-ish logger (startup/info only; no per-request logging).
type Level = 'info' | 'warn' | 'error';
function emit(level: Level, msg: string, extra?: unknown): void {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${msg}`;
  const out = level === 'info' ? console.log : console.error;
  if (extra === undefined) out(line);
  else out(line, extra instanceof Error ? extra.message : extra);
}
export const log = {
  info: (m: string, e?: unknown) => emit('info', m, e),
  warn: (m: string, e?: unknown) => emit('warn', m, e),
  error: (m: string, e?: unknown) => emit('error', m, e),
};

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: unknown }).cause;
    if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) {
      return `${e.message}: ${cause.message}`;
    }
    return e.message || e.name;
  }
  return String(e);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
