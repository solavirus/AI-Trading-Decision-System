/** Sprint 3.9 — faithful backend port of `prototype/index.html`'s news pipeline (Sprint 2.2,
 * `runNewsPipeline`/`newsStage1TimeFilter`.../`newsStage5Score`). Logic and constants are copied
 * verbatim (not redesigned) — this is exactly what Section 1 means by "复用Manual Prompt builder
 *必须做结构性接线": the manual pipeline's own news selection rules, now runnable with no browser,
 * so Scheduled analysis selects news the identical way Manual always has. */
import type { RawItem } from '../types.js';
import type { SelectedNewsEvent } from './types.js';

const NEWS_RANGE_DAYS: Record<string, number> = { '最近3天': 3, '最近7天': 7, '最近14天': 14, '最近30天': 30 };
function newsRangeMs(rangeLabel: string): number { return (NEWS_RANGE_DAYS[rangeLabel] || 7) * 24 * 60 * 60 * 1000; }

const NEWS_ASSET_KEYWORDS: Record<string, { direct: string[]; indirect: string[] }> = {
  BTC: { direct: ['btc', 'bitcoin', '比特币', 'btcusdt'], indirect: ['bitcoin etf', 'spot etf', '现货etf', 'blackrock', '贝莱德', 'microstrategy'] },
  ETH: { direct: ['eth', 'ethereum', '以太坊', 'ethusdt'], indirect: ['eth etf', '以太坊etf', 'staking', '质押', 'layer 2'] },
  SOL: { direct: ['sol', 'solana', '索拉纳', 'solusdt'], indirect: [] },
  XRP: { direct: ['xrp', 'ripple', '瑞波', 'xrpusdt'], indirect: [] },
  DOGE: { direct: ['doge', 'dogecoin', '狗狗币', 'dogeusdt'], indirect: [] },
  BNB: { direct: ['bnb', 'binance coin', '币安币', 'bnbusdt'], indirect: ['binance', '币安'] },
};
const NEWS_MACRO_KEYWORDS = ['fed', 'federal reserve', '美联储', 'fomc', 'cpi', 'ppi', 'interest rate', '利率', 'treasury', '国债', 'us dollar', 'sec', 'regulation', '监管'];
const NEWS_MAJOR_EVENT_KEYWORDS = ['etf', 'approval', 'rejection', 'regulation', 'sec', 'fed', 'fomc', 'cpi', 'rate', 'hack', 'exploit', 'liquidation', 'insolvency', 'bankruptcy', 'listing', 'delisting', 'outage'];
/** Same official/api source-name list `NEWS_SOURCE_PRESETS` defines in the frontend — kept in sync
 * manually (small, static list; the frontend's news-source preset catalog is a UI/config concern
 * out of this sprint's scope to also port). */
const NEWS_OFFICIAL_SOURCE_NAMES = new Set(['Binance Announcements', 'Coinbase Blog', 'OKX Support', 'Bybit Announcements', 'SEC', 'Federal Reserve']);

function newsBaseSymbol(assetSymbol: string): string { return String(assetSymbol || '').split('/')[0]; }
function newsParseSources(detail: string | undefined): string[] {
  const m = String(detail || '').match(/来源：([^·]+)/);
  if (!m) return [];
  return m[1].trim().split('、').map((s) => s.trim()).filter(Boolean);
}
function newsContentText(item: RawItem): string {
  const m = String(item.detail || '').match(/原文：(.*)$/);
  return String(item.label || '') + (m ? ' ' + m[1] : '');
}

type NewsWorkItem = RawItem & { __tier?: string; __sources?: string[] };

function newsStage1TimeFilter(items: RawItem[], rangeLabel: string, now: number): RawItem[] {
  const windowMs = newsRangeMs(rangeLabel);
  return items.filter((it) => {
    const hasTime = typeof it.timestamp === 'number' && !isNaN(it.timestamp);
    if (!hasTime) {
      const sources = newsParseSources(it.detail);
      return sources.some((s) => NEWS_OFFICIAL_SOURCE_NAMES.has(s));
    }
    return now - (it.timestamp as number) <= windowMs;
  });
}
function newsStage2AssetRelevance(items: RawItem[], baseSymbol: string): NewsWorkItem[] {
  const kw = NEWS_ASSET_KEYWORDS[baseSymbol] || { direct: [baseSymbol.toLowerCase()], indirect: [] };
  return items
    .map((it) => {
      const text = newsContentText(it).toLowerCase();
      const directHit = kw.direct.some((k) => text.includes(k));
      const macroHit = NEWS_MACRO_KEYWORDS.some((k) => text.includes(k));
      const indirectHit = kw.indirect.some((k) => text.includes(k));
      let tier: string | null = null;
      if (directHit) tier = 'direct'; else if (macroHit) tier = 'macro'; else if (indirectHit) tier = 'indirect';
      return { it, tier };
    })
    .filter((x) => x.tier)
    .map((x) => ({ ...x.it, __tier: x.tier as string, __sources: newsParseSources(x.it.detail) }));
}
function newsNormalizeUrl(u: string | undefined): string {
  try { const url = new URL(u as string); return url.origin + url.pathname; } catch { return String(u || '').split('?')[0]; }
}
function newsNormalizeTitle(t: string | undefined): string { return String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ''); }
function newsStage3Dedup(items: NewsWorkItem[]): NewsWorkItem[] {
  const seenUrl = new Set<string>(), seenTitle = new Set<string>(), out: NewsWorkItem[] = [];
  for (const it of items) {
    const u = newsNormalizeUrl(it.sourceUrl), nt = newsNormalizeTitle(it.label);
    if (u && seenUrl.has(u)) continue;
    if (nt && seenTitle.has(nt)) continue;
    if (u) seenUrl.add(u);
    if (nt) seenTitle.add(nt);
    out.push(it);
  }
  return out;
}
function newsTitleTokens(text: string): Set<string> {
  return new Set(String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1));
}
function newsTokenOverlapRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0; for (const w of a) if (b.has(w)) inter++;
  return inter / Math.min(a.size, b.size);
}
const NEWS_CLUSTER_TOKEN_OVERLAP_MIN = 0.6;
const NEWS_CLUSTER_TIME_WINDOW_MS = 6 * 60 * 60 * 1000;

interface NewsCluster { rep: NewsWorkItem; tokens: Set<string>; members: NewsWorkItem[]; sourcesSet: Set<string>; articleIds: string[] }
function newsStage4Cluster(items: NewsWorkItem[]): NewsCluster[] {
  const clusters: NewsCluster[] = [];
  for (const it of items) {
    const tokens = newsTitleTokens(newsContentText(it));
    let target: NewsCluster | null = null;
    for (const c of clusters) {
      const timeOk = Math.abs((c.rep.timestamp as number) - (it.timestamp as number)) <= NEWS_CLUSTER_TIME_WINDOW_MS;
      const overlapOk = newsTokenOverlapRatio(c.tokens, tokens) >= NEWS_CLUSTER_TOKEN_OVERLAP_MIN;
      if (timeOk && overlapOk) { target = c; break; }
    }
    if (target) {
      target.members.push(it);
      (it.__sources || []).forEach((s) => target!.sourcesSet.add(s));
      target.articleIds.push(it.id);
      if ((it.timestamp as number) > (target.rep.timestamp as number)) target.rep = it;
    } else {
      clusters.push({ rep: it, tokens, members: [it], sourcesSet: new Set(it.__sources || []), articleIds: [it.id] });
    }
  }
  return clusters;
}
function newsStage5Score(cluster: NewsCluster, _baseSymbol: string, rangeLabel: string, now: number): number {
  const text = newsContentText(cluster.rep).toLowerCase();
  let score = 0;
  if (cluster.rep.__tier === 'direct') score += 30;
  else if (cluster.rep.__tier === 'macro') score += 15;
  else if (cluster.rep.__tier === 'indirect') score += 10;
  if ([...cluster.sourcesSet].some((s) => NEWS_OFFICIAL_SOURCE_NAMES.has(s))) score += 15;
  score += Math.min(cluster.sourcesSet.size - 1, 4) * 5;
  const ageMs = now - (cluster.rep.timestamp as number);
  if (ageMs < 6 * 3600 * 1000) score += 15; else if (ageMs < 24 * 3600 * 1000) score += 10; else if (ageMs < 72 * 3600 * 1000) score += 5;
  if (NEWS_MAJOR_EVENT_KEYWORDS.some((k) => text.includes(k))) score += 20;
  if (ageMs <= newsRangeMs(rangeLabel) / 2) score += 5;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export interface NewsPipelineResult {
  stats: { fetchedCount: number; filteredCount: number; clusteredCount: number; selectedCount: number };
  selectedEvents: SelectedNewsEvent[];
}

/** Stages 1-6 in one call — pure/synchronous, mirrors `runNewsPipeline()` exactly. `freshNewsRawItems`
 * is always required here (unlike the frontend's Dashboard-cache fallback) — this engine only ever
 * runs against freshly-fetched source data (Section 20: snapshot coherence), never a stale cache. */
export function runNewsPipeline(assetSymbol: string, rangeLabel: string, freshNewsRawItems: RawItem[]): NewsPipelineResult {
  const now = Date.now();
  const raw = freshNewsRawItems || [];
  const baseSymbol = newsBaseSymbol(assetSymbol);

  const afterTime = newsStage1TimeFilter(raw, rangeLabel, now);
  const afterAsset = newsStage2AssetRelevance(afterTime, baseSymbol);
  const afterDedup = newsStage3Dedup(afterAsset);
  const clusters = newsStage4Cluster(afterDedup);

  const scored = clusters.map((c) => ({ c, score: newsStage5Score(c, baseSymbol, rangeLabel, now) }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 10);

  const selectedEvents: SelectedNewsEvent[] = top.map(({ c, score }) => {
    const allSources = [...c.sourcesSet];
    return {
      id: c.rep.id,
      title: c.rep.label,
      summary: c.rep.detail || '',
      category: undefined,
      publishedAt: typeof c.rep.timestamp === 'number' ? new Date(c.rep.timestamp).toISOString() : null,
      sourceCount: allSources.length,
      sources: allSources.slice(0, 5),
      importanceScore: score,
      relatedAssets: [baseSymbol],
      sourceArticleIds: c.articleIds,
    };
  });

  return {
    stats: { fetchedCount: raw.length, filteredCount: afterDedup.length, clusteredCount: clusters.length, selectedCount: selectedEvents.length },
    selectedEvents,
  };
}
