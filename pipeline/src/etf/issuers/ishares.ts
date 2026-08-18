import { fetchText } from '../../util/http.js';

/** iShares embeds fund facts as an HTML-entity-escaped JSON blob directly in the product page
 * (confirmed 2026-08-05 via curl — no separate API call needed, no JS rendering required).
 * Product page slugs per ticker below; only IBIT's has been confirmed. Add more by visiting
 * ishares.com, finding the product page, and pulling the numeric id + slug out of its URL. */
const PRODUCT_PAGES: Record<string, string> = {
  IBIT: 'us/products/333011/ishares-bitcoin-trust-etf',
  // ETHA: not found yet — ishares.com's product-screener endpoints didn't return it during
  // investigation on 2026-08-05; needs the product page found manually and added here.
};

export async function fetchIsharesSharesOutstanding(ticker: string): Promise<number | null> {
  const slug = PRODUCT_PAGES[ticker];
  if (!slug) return null;
  const html = await fetchText(`https://www.ishares.com/${slug}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const m = html.match(/Shares Outstanding&quot;,&quot;formattedValue&quot;:&quot;([\d,]+)&quot;/);
  if (!m) return null;
  return parseFloat(m[1].replace(/,/g, ''));
}
