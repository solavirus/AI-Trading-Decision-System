const DEFAULT_TIMEOUT_MS = 8000;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = any>(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<T> {
  return withTimeout(async (signal) => {
    const res = await fetch(url, { signal, headers: opts.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return (await res.json()) as T;
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}

export async function fetchText(url: string, opts: { timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<string> {
  return withTimeout(async (signal) => {
    const res = await fetch(url, { signal, headers: opts.headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
}
