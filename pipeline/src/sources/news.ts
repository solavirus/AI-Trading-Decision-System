import type { RawItem, SourceResult } from '../types.js';
import { fetchText, fetchJson } from '../util/http.js';
import { parseRss, type RssItem } from '../util/rss.js';
import { clusterArticlesIntoEvents, type NewsArticle } from '../news/cluster.js';
import { translateAllToZh } from '../util/translate.js';
import { listNewsSources, seedNewsSourcesIfEmpty, updateNewsSourceFetchStatus } from '../db.js';

/** One-time seed for a fresh DB — after this, news_sources is the only source of truth (see
 * 新闻源管理: sources are added/edited/deleted for real via /api/news-sources, not hardcoded). */
export const BUILTIN_SEED: { name: string; url: string; type: 'rss'; category: string }[] = [
  { name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', type: 'rss', category: '加密媒体' },
  { name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', type: 'rss', category: '加密媒体' },
  { name: 'Decrypt', url: 'https://decrypt.co/feed', type: 'rss', category: '加密媒体' },
];

/** 交易所公告没有通用的 RSS/Atom 标准可用 —— 每家都是各自的 JSON 结构，逐家实测出来的真实公开
 * 接口（无需 key）。matched purely by URL pattern, not by the source's declared `type`, so a user
 * adding an unrecognized "api"-type source still honestly falls back to "not fetchable" instead
 * of silently trying (and failing) to parse it as one of these three. */
interface ExchangeAdapter { name: string; match: (url: string) => boolean; fetch: (url: string) => Promise<RssItem[]> }

async function fetchBinanceAnnouncements(url: string): Promise<RssItem[]> {
  const json = await fetchJson<any>(url, { timeoutMs: 10000 });
  const articles: any[] = json?.data?.catalogs?.[0]?.articles ?? [];
  return articles.map((a) => ({
    title: a.title,
    link: `https://www.binance.com/en/support/announcement/${a.code}`,
    pubDate: a.releaseDate,
    description: '',
  }));
}
async function fetchOkxAnnouncements(url: string): Promise<RssItem[]> {
  const json = await fetchJson<any>(url, { timeoutMs: 10000 });
  const groups: any[] = json?.data ?? [];
  const details: any[] = groups.flatMap((g) => g.details ?? []);
  return details.map((d) => ({
    title: d.title,
    link: d.url,
    pubDate: Number(d.pTime),
    description: '',
  }));
}
async function fetchBybitAnnouncements(url: string): Promise<RssItem[]> {
  const json = await fetchJson<any>(url, { timeoutMs: 10000 });
  const list: any[] = json?.result?.list ?? [];
  return list.map((i) => ({
    title: i.title,
    link: i.url,
    pubDate: i.dateTimestamp,
    description: i.description || '',
  }));
}

const EXCHANGE_ADAPTERS: ExchangeAdapter[] = [
  { name: 'binance', match: (u) => u.includes('binance.com/bapi/composite'), fetch: fetchBinanceAnnouncements },
  { name: 'okx', match: (u) => u.includes('okx.com/api/v5/support/announcements'), fetch: fetchOkxAnnouncements },
  { name: 'bybit', match: (u) => u.includes('api.bybit.com/v5/announcements'), fetch: fetchBybitAnnouncements },
];

export function findExchangeAdapter(url: string | null | undefined): ExchangeAdapter | undefined {
  if (!url) return undefined;
  return EXCHANGE_ADAPTERS.find((a) => a.match(url));
}

/** Whether a (type, url) pair can genuinely be fetched right now — rss/official always can (the
 * generic RSS pipeline); api can ONLY if its url matches one of the three known exchange
 * adapters above; scrape (and any other api url) can't yet. Single source of truth, reused by
 * fetchNews() itself, server.ts's serializeSource (drives the UI's real/fake status display),
 * and the real pre-save test in POST/PATCH /api/news-sources. */
export function isSourceFetchable(type: string, url: string | null | undefined): boolean {
  if (type === 'rss' || type === 'official') return true;
  if (type === 'api') return !!findExchangeAdapter(url);
  return false;
}

/** Fetches raw items for one source, routing through a known exchange adapter when the url
 * matches one, otherwise treating it as a generic RSS/Atom feed. Throws on failure — callers
 * decide how to record/report that, never fabricate a result here. */
export async function fetchArticlesForSource(url: string): Promise<RssItem[]> {
  const adapter = findExchangeAdapter(url);
  if (adapter) return adapter.fetch(url);
  const xml = await fetchText(url, { timeoutMs: 10000 });
  return parseRss(xml);
}

/** Per-source article cache so each source's own configured 抓取频率 (fetch_interval_minutes)
 * is genuinely respected instead of everything refetching on every call — mirrors the same
 * in-memory-cache pattern server.ts already uses for the dashboard's 20s TTL, just keyed per
 * source with a per-source interval. Not persisted across restarts (same as every other source
 * here); a fresh process just treats every source as immediately due. */
const sourceCache = new Map<string, { fetchedAt: number; articles: NewsArticle[] }>();

/** Aggregates every genuinely-fetchable, enabled source (rss/official always; api only when
 * isSourceFetchable() says so) into events. Non-fetchable sources (api without a known adapter,
 * scrape) are stored for real in the DB but skipped here — never faked. */
export async function fetchNews(): Promise<SourceResult> {
  seedNewsSourcesIfEmpty(BUILTIN_SEED);
  const fetchedAt = Date.now();
  const sources = listNewsSources().filter((s) => s.enabled && s.url && isSourceFetchable(s.type, s.url));

  const articles: NewsArticle[] = [];
  const errors: string[] = [];

  await Promise.all(
    sources.map(async (s) => {
      const cached = sourceCache.get(s.id);
      const dueAt = cached ? cached.fetchedAt + s.fetch_interval_minutes * 60_000 : 0;
      if (cached && fetchedAt < dueAt) {
        articles.push(...cached.articles);
        return;
      }
      try {
        const items = await fetchArticlesForSource(s.url!);
        const feedArticles: NewsArticle[] = [];
        const lookbackMs = s.lookback_hours * 60 * 60 * 1000;
        for (const item of items) {
          if (fetchedAt - item.pubDate <= lookbackMs) feedArticles.push({ ...item, feed: s.name });
        }
        sourceCache.set(s.id, { fetchedAt, articles: feedArticles });
        articles.push(...feedArticles);
        updateNewsSourceFetchStatus(s.id, { fetchedAt, status: 'ok', itemCount: items.length });
      } catch (err: any) {
        errors.push(`${s.name}: ${err.message}`);
        updateNewsSourceFetchStatus(s.id, { fetchedAt, status: 'error', error: err.message });
        // Fall back to the last good cache (if any) rather than silently dropping the source for
        // this one poll — a transient network blip shouldn't blank out an otherwise-healthy feed.
        if (cached) articles.push(...cached.articles);
      }
    })
  );

  if (articles.length === 0) {
    return { key: 'news', status: 'error', fetchedAt, itemsRaw: [], note: errors.join('; ') || (sources.length === 0 ? '未配置任何启用的新闻源' : 'no articles in lookback window') };
  }

  const events = clusterArticlesIntoEvents(articles);
  // Clustering itself runs on the original English headlines (keyword-overlap matching) before
  // this point — translate only for display, never before clustering.
  const headlinesZh = await translateAllToZh(events.map((e) => e.headline));
  const itemsRaw: RawItem[] = events.map((event, i) => ({
    id: `news-event-${i}`,
    label: headlinesZh[i],
    value: `${event.sources.length} 家媒体报道${event.articleCount > event.sources.length ? `（共 ${event.articleCount} 篇）` : ''}`,
    polarity: event.polarity,
    detail: `来源：${event.sources.join('、')}${headlinesZh[i] !== event.headline ? ` · 原文：${event.headline}` : ''}`,
    sourceUrl: event.link,
    timestamp: event.latestPubDate,
  }));

  return {
    key: 'news',
    status: 'ok',
    fetchedAt,
    itemsRaw,
    note: errors.length ? `partial feeds: ${errors.join('; ')}` : undefined,
  };
}
