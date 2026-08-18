import type { RssItem } from '../util/rss.js';
import type { Polarity } from '../types.js';

export interface NewsArticle extends RssItem {
  feed: string;
}

export interface NewsEvent {
  headline: string;
  articleCount: number;
  sources: string[];
  link: string;
  latestPubDate: number;
  polarity: Polarity;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'is', 'are', 'was', 'were',
  'with', 'as', 'at', 'by', 'from', 'this', 'that', 'it', 'its', 'be', 'has', 'have', 'had',
  'will', 'after', 'over', 'up', 'down', 'new', 'says', 'said', 'about', 'into', 'amid', 'than',
]);

const BULLISH_WORDS = [
  'surge', 'surges', 'rally', 'rallies', 'soar', 'soars', 'jump', 'jumps', 'gain', 'gains',
  'record high', 'all-time high', 'approve', 'approves', 'approval', 'adopt', 'adoption',
  'inflow', 'inflows', 'bullish', 'breakout', 'partnership', 'launch', 'launches', 'buy',
  'accumulate', 'institutional', 'upgrade',
];
const BEARISH_WORDS = [
  'crash', 'crashes', 'plunge', 'plunges', 'drop', 'drops', 'fall', 'falls', 'decline', 'declines',
  'hack', 'hacked', 'exploit', 'exploited', 'sue', 'sued', 'lawsuit', 'ban', 'bans', 'reject',
  'rejects', 'rejection', 'outflow', 'outflows', 'bearish', 'sell-off', 'selloff', 'liquidated',
  'liquidation', 'liquidations', 'fraud', 'scam', 'delist', 'delists', 'fine', 'fined', 'penalty',
];

function keywordsOf(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(words);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function scorePolarity(text: string): Polarity {
  const lower = text.toLowerCase();
  let bull = 0, bear = 0;
  for (const w of BULLISH_WORDS) if (lower.includes(w)) bull++;
  for (const w of BEARISH_WORDS) if (lower.includes(w)) bear++;
  if (bull === bear) return 'neutral';
  return bull > bear ? 'bullish' : 'bearish';
}

const TIME_WINDOW_MS = 18 * 60 * 60 * 1000;
const SIMILARITY_THRESHOLD = 0.22;

/** Groups near-duplicate articles about the same event into one NewsEvent, so the pipeline
 * feeds the model "N sources reported X" rather than N separate near-identical article inputs
 * ("新闻按事件聚合，不按文章输入"). Deterministic keyword-overlap clustering — no LLM involved. */
export function clusterArticlesIntoEvents(articles: NewsArticle[]): NewsEvent[] {
  const sorted = [...articles].sort((a, b) => a.pubDate - b.pubDate);
  const clusters: { items: NewsArticle[]; keywordSets: Set<string>[]; firstSeen: number }[] = [];

  for (const article of sorted) {
    const kw = keywordsOf(article.title);
    let bestCluster: (typeof clusters)[number] | null = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      if (article.pubDate - cluster.firstSeen > TIME_WINDOW_MS) continue;
      const repKeywords = cluster.keywordSets[0]; // compare against the founding article
      const score = jaccard(kw, repKeywords);
      if (score > bestScore) { bestScore = score; bestCluster = cluster; }
    }

    if (bestCluster && bestScore >= SIMILARITY_THRESHOLD) {
      bestCluster.items.push(article);
      bestCluster.keywordSets.push(kw);
    } else {
      clusters.push({ items: [article], keywordSets: [kw], firstSeen: article.pubDate });
    }
  }

  const events: NewsEvent[] = clusters.map((cluster) => {
    const items = cluster.items;
    const combinedText = items.map((i) => i.title + ' ' + i.description).join(' ');
    const latest = items.reduce((a, b) => (b.pubDate > a.pubDate ? b : a));
    return {
      headline: items[0].title,
      articleCount: items.length,
      sources: [...new Set(items.map((i) => i.feed))],
      link: items[0].link,
      latestPubDate: latest.pubDate,
      polarity: scorePolarity(combinedText),
    };
  });

  // Most-corroborated events (reported by multiple outlets) first, then most recent.
  events.sort((a, b) => b.articleCount - a.articleCount || b.latestPubDate - a.latestPubDate);
  return events;
}
