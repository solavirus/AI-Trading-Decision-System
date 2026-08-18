export interface RssItem {
  title: string;
  link: string;
  pubDate: number; // ms epoch
  description: string;
}

function extractTag(block: string, tag: string): string {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  if (!m) return '';
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return v
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0*39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Minimal, dependency-free RSS 2.0 parser — good enough for standard news feeds, not a full XML parser. */
export function parseRss(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const itemBlocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of itemBlocks) {
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDateStr = extractTag(block, 'pubDate');
    const description = extractTag(block, 'description');
    const pubDate = pubDateStr ? Date.parse(pubDateStr) : NaN;
    if (!title) continue;
    items.push({ title, link, pubDate: isNaN(pubDate) ? Date.now() : pubDate, description });
  }
  return items;
}
