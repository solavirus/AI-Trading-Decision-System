import { fetchJson } from './http.js';

/** Unofficial Google Translate endpoint (the one most "free translate" npm/PyPI wrappers use
 * under the hood) — no key, no official SLA. Can break or get rate-limited without notice.
 * Fails soft: on any error, callers get the original English text back rather than a broken
 * page. In-memory cache means repeated text (very common for macro calendar event names) only
 * gets translated once per server process lifetime. */
const cache = new Map<string, string>();

export async function translateToZh(text: string): Promise<string> {
  if (!text) return text;
  const cached = cache.get(text);
  if (cached) return cached;
  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const res = await fetchJson<[[[string, string, ...unknown[]]]]>(url, { timeoutMs: 5000 });
    const translated = res[0]?.map((seg) => seg[0]).join('') || text;
    cache.set(text, translated);
    return translated;
  } catch {
    return text; // fail soft — original English beats a broken card
  }
}

export async function translateAllToZh(texts: string[]): Promise<string[]> {
  return Promise.all(texts.map((t) => translateToZh(t)));
}
