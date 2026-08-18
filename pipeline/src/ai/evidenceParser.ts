import { createHash } from 'node:crypto';
import type { AIImageRequest, AIEngineErrorCode } from './types.js';
import { getRoleConfig, saveRoleConfig } from './configStore.js';
import { getConnection, type AIConnection } from './connectionStore.js';
import { getTimeoutConfig, classifyError } from './engine.js';
import { readJsonStoreOrDefault, withStoreWriteLock } from '../util/safeJsonStore.js';
import { analyzeOpenAIImage } from './providers/openaiProvider.js';
import { analyzeAnthropicImage } from './providers/anthropicProvider.js';
import { analyzeGoogleImage } from './providers/googleProvider.js';
import { analyzeOpenAICompatibleImage } from './providers/openaiCompatibleProvider.js';

/** Sprint 3.3B: Image Evidence Parser — a separate, additive backend module. Does NOT touch
 * engine.ts's runAIAnalysis()/validateAIAnalyzeRequest() or the /api/ai/analyze contract; only
 * reuses two of its already-exported pieces (getTimeoutConfig(), classifyError()).
 *
 * Sprint 3.3B.2: the role now resolves to a CONNECTION (connectionStore.ts) instead of a bare
 * provider-type string — the same image, model, and prompt can be routed through any of
 * potentially several configured connections (e.g. two different OpenAI-Compatible relays), not
 * just "the one openai-compatible config that happens to exist". */

const ROLE_NAME = 'evidence-parser';

/** Only these 4 adapters have an analyzeXImage() export at all — DeepSeek's public API has no
 * image input support to wrap, so it's deliberately absent here, not merely disabled. Capability
 * is therefore a structural fact about which functions exist for a connection's TYPE, never a
 * guess from a model name string. Every function here now accepts the same optional
 * {apiKey, baseUrl} overrides tuple, so a connection's OWN stored credentials can be threaded
 * through per-call instead of each adapter falling back to a single global provider-type config. */
const IMAGE_CAPABLE_ANALYZERS: Record<string, (req: AIImageRequest, overrides?: { apiKey?: string; baseUrl?: string }) => Promise<{ rawText: string }>> = {
  openai: analyzeOpenAIImage,
  anthropic: analyzeAnthropicImage,
  google: analyzeGoogleImage,
  'openai-compatible': analyzeOpenAICompatibleImage,
};

export function providerSupportsImageInput(type: string): boolean {
  return type in IMAGE_CAPABLE_ANALYZERS;
}

/** Sprint 3.3B.2: reads `connectionId` (current shape) with a fallback to the pre-3.3B.2
 * `provider` field (old shape — see configStore.ts's RoleConfig comment for why the fallback is
 * always a valid connection id post-migration). Writes only ever use `connectionId` going
 * forward — `provider` is never written again after this sprint. */
export function getEvidenceParserRole(): { connectionId?: string; model?: string } {
  const role = getRoleConfig(ROLE_NAME);
  return { connectionId: role.connectionId || role.provider, model: role.model };
}
export function saveEvidenceParserRole(patch: { connectionId?: string; model?: string }) {
  return saveRoleConfig(ROLE_NAME, { connectionId: patch.connectionId, model: patch.model });
}

const CONTENT_TYPES = ['social_post', 'chart', 'news_screenshot', 'document_screenshot', 'other'] as const;
export type ParsedImageContentType = typeof CONTENT_TYPES[number];

/** Product Decision 4 (Sprint 3.3B.2): WHO appears to have published a social-media screenshot is
 * part of the evidence itself — preserved, never independently verified (Product Decision 3: the
 * user owns evidence authenticity; this system never checks whether an account is real, whether a
 * post exists, or whether a screenshot was edited). */
export interface EvidenceSource {
  platform: string | null;
  displayName: string | null;
  handle: string | null;
}
export interface EvidenceEngagement {
  replies?: string | null;
  reposts?: string | null;
  likes?: string | null;
  views?: string | null;
}
export interface EvidenceContext {
  publishedAt: string | null;
  engagement: EvidenceEngagement | null;
}

export interface ParsedImageEvidence {
  evidenceId: string;
  contentType: ParsedImageContentType;
  source: EvidenceSource | null;
  context: EvidenceContext | null;
  extractedText: string;
  entities: string[];
  relatedAssets: string[];
  observations: string[];
  uncertainFields: string[];
  parserConnectionId: string;
  parserProvider: string;
  parserModel: string;
  parsedAt: string;
}

export type EvidenceParserErrorCode =
  | AIEngineErrorCode
  | 'role_not_configured'
  | 'connection_not_found'
  | 'connection_disabled'
  | 'evidence_model_not_multimodal'
  | 'parser_invalid_json'
  | 'parser_schema_invalid';

export type EvidenceParseResult =
  | { ok: true; result: ParsedImageEvidence }
  | { ok: false; error: { code: EvidenceParserErrorCode; message: string } };

/** Bumped whenever the extraction contract (prompt or expected JSON shape) changes in a way that
 * could make an old cached parse structurally stale — Task 13's cache-key upgrade folds this in
 * alongside connectionId/model, so a prompt change alone (even reusing the exact same connection
 * and model as before) invalidates old cache entries too. */
const PARSER_SCHEMA_VERSION = 2;

/** Small, dedicated extraction-only prompt — deliberately NOT the main trading Prompt Builder.
 * Sprint 3.3B.2 (Product Decision 4 / Task 9): social-media screenshots now extract in a fixed
 * priority order — source identity first, then post content, then assets/entities, then
 * timestamp, then engagement, then everything else — and the parser is told explicitly that it is
 * describing the screenshot, never verifying who actually posted it (Product Decision 3). */
const EVIDENCE_PARSER_PROMPT = [
  'You are an image evidence extractor for a trading-decision-support research tool.',
  'You ONLY extract and structure information that is visibly present in the supplied image.',
  'You NEVER make trading recommendations, predictions, or judgments of any kind.',
  'You NEVER decide or imply LONG, SHORT, WAIT, BUY, SELL, bullish, bearish, influence/importance, or a confidence score.',
  'You NEVER verify whether a social media post is authentic, whether an account is genuine, or whether a screenshot has been edited — you only describe what the image visibly shows, exactly as a neutral transcript would.',
  'You NEVER invent information you cannot actually read in the image — if a field is unreadable or absent, use null (for source/context fields) or list its name in uncertainFields (for everything else) instead of guessing.',
  '',
  'For a social media post screenshot, extract in this priority order:',
  '1. Visible source identity: platform (e.g. "X", "Twitter", "Weibo"), display name, handle/username.',
  '2. Visible post content (the text of the post itself).',
  '3. Related assets/entities mentioned or shown (tickers, symbols, named entities).',
  '4. Visible timestamp of the post.',
  '5. Visible engagement/context (reply/repost/like/view counts), if shown.',
  '6. Any other observable information (e.g. an embedded chart\'s visible values).',
  '',
  'Return STRICT JSON only — no markdown, no code fences, no commentary before or after — matching exactly this shape:',
  '{"contentType":"social_post|chart|news_screenshot|document_screenshot|other","source":{"platform":"string|null","displayName":"string|null","handle":"string|null"}|null,"context":{"publishedAt":"string|null","engagement":{"replies":"string|null","reposts":"string|null","likes":"string|null","views":"string|null"}|null}|null,"extractedText":"string","entities":["string"],"relatedAssets":["string"],"observations":["string"],"uncertainFields":["string"]}',
  'source/context: only for social-media-style screenshots with a visible author/post structure — use null for both (the whole object, not per-field) when the image has no such structure (e.g. a bare chart with no post wrapper).',
  'extractedText: the visible text content (post text, headline, or on-chart labels), transcribed as-is.',
  'entities: visible author/account names, publications, or named entities (may overlap with source, that is fine).',
  'relatedAssets: visible ticker/symbol strings (e.g. "BTC/USDT"), if any.',
  'observations: short, purely descriptive statements about what is visible (e.g. "RSI 63.9 is visible", "the screenshot visibly shows the post as published by 王短鸟") — never an interpretation of significance or future price direction.',
  'uncertainFields: names of top-level fields you could not read reliably (e.g. "context.publishedAt", "source.handle").',
].join('\n');

function isNullableString(v: any): boolean {
  return v === null || typeof v === 'string';
}
function validateParsedImageEvidenceShape(p: any): string | null {
  if (!p || typeof p !== 'object') return '响应必须是一个 JSON 对象';
  if (!CONTENT_TYPES.includes(p.contentType)) return 'contentType 非法枚举值：' + p.contentType;
  if (typeof p.extractedText !== 'string') return 'extractedText 必须是字符串';
  const stringArrayFields = ['entities', 'relatedAssets', 'observations', 'uncertainFields'] as const;
  for (const f of stringArrayFields) {
    if (!Array.isArray(p[f]) || !p[f].every((x: any) => typeof x === 'string')) return f + ' 必须是字符串数组';
  }
  if (p.source !== null && p.source !== undefined) {
    if (typeof p.source !== 'object') return 'source 必须是对象或 null';
    if (!isNullableString(p.source.platform) || !isNullableString(p.source.displayName) || !isNullableString(p.source.handle)) {
      return 'source 的字段必须是字符串或 null';
    }
  }
  if (p.context !== null && p.context !== undefined) {
    if (typeof p.context !== 'object') return 'context 必须是对象或 null';
    if (!isNullableString(p.context.publishedAt)) return 'context.publishedAt 必须是字符串或 null';
    if (p.context.engagement !== null && p.context.engagement !== undefined) {
      if (typeof p.context.engagement !== 'object') return 'context.engagement 必须是对象或 null';
      for (const f of ['replies', 'reposts', 'likes', 'views'] as const) {
        if (p.context.engagement[f] !== undefined && !isNullableString(p.context.engagement[f])) return `context.engagement.${f} 必须是字符串或 null`;
      }
    }
  }
  return null;
}

/* ---------- Parse cache ----------
   Sprint 3.3B.2, Task 13: cache identity is now image-hash + connectionId + model + parser schema
   version — the same exact image parsed through a DIFFERENT model or connection may legitimately
   produce different structured evidence (a cheaper vision model may read less text, a prompt
   change may extract new fields), so a naive image-only key would silently serve stale/
   incompatible results. Still never applied to live market data — only to this one immutable-
   upload use case. */
const CACHE_PATH = 'data/evidence_parse_cache.json';
const CACHE_STORE_NAME = 'EvidenceParseCache';
type ParseCacheFile = Record<string, ParsedImageEvidence>;

function loadCache(): ParseCacheFile {
  return readJsonStoreOrDefault<ParseCacheFile>(CACHE_PATH, CACHE_STORE_NAME, {});
}
function saveCacheEntry(key: string, entry: ParsedImageEvidence): void {
  withStoreWriteLock<ParseCacheFile>(CACHE_PATH, CACHE_STORE_NAME, {}, (cache) => {
    cache[key] = entry;
    return cache;
  });
}
function cacheKey(imageBase64: string, connectionId: string, model: string): string {
  const imageHash = createHash('sha256').update(Buffer.from(imageBase64, 'base64')).digest('hex');
  return createHash('sha256').update(`${imageHash}|${connectionId}|${model}|v${PARSER_SCHEMA_VERSION}`).digest('hex');
}

export interface EvidenceImageParseInput {
  imageBase64: string;
  mimeType: string;
  evidenceId: string;
}

function resolveConnectionForRole(): { ok: true; connection: AIConnection } | { ok: false; error: { code: EvidenceParserErrorCode; message: string } } {
  const role = getEvidenceParserRole();
  if (!role.connectionId || !role.model) {
    return { ok: false, error: { code: 'role_not_configured', message: 'Evidence Parser 角色尚未配置连接/模型，请先在 Settings 中配置' } };
  }
  const connection = getConnection(role.connectionId);
  if (!connection) {
    return { ok: false, error: { code: 'connection_not_found', message: `Evidence Parser 角色引用的连接（${role.connectionId}）不存在，可能已被删除` } };
  }
  if (!connection.enabled) {
    return { ok: false, error: { code: 'connection_disabled', message: `Evidence Parser 角色引用的连接"${connection.name}"已被禁用` } };
  }
  if (!providerSupportsImageInput(connection.type)) {
    return { ok: false, error: { code: 'evidence_model_not_multimodal', message: `连接"${connection.name}"的类型（${connection.type}）不支持图片输入，无法解析图片证据` } };
  }
  if (!connection.apiKey) {
    return { ok: false, error: { code: 'provider_not_configured', message: `连接"${connection.name}"未配置 API Key` } };
  }
  return { ok: true, connection };
}

/** Never throws — always resolves to a discriminated result, mirroring engine.ts's
 * runAIAnalysis()/classifyError() convention on the main path. */
export async function runEvidenceImageParse(input: EvidenceImageParseInput): Promise<EvidenceParseResult> {
  const resolved = resolveConnectionForRole();
  if (!resolved.ok) return resolved;
  const connection = resolved.connection;
  const role = getEvidenceParserRole();
  const model = role.model!;

  if (!input.imageBase64) {
    return { ok: false, error: { code: 'invalid_request', message: '缺少图片数据' } };
  }

  const key = cacheKey(input.imageBase64, connection.id, model);
  const cached = loadCache()[key];
  if (cached) {
    return { ok: true, result: { ...cached, evidenceId: input.evidenceId } };
  }

  const { timeoutMs } = getTimeoutConfig();
  const startedMs = Date.now();
  const analyzeImage = IMAGE_CAPABLE_ANALYZERS[connection.type];
  let raw: { rawText: string };
  try {
    raw = await Promise.race([
      analyzeImage(
        { model, prompt: EVIDENCE_PARSER_PROMPT, imageBase64: input.imageBase64, mimeType: input.mimeType },
        { apiKey: connection.apiKey, baseUrl: connection.baseUrl },
      ),
      new Promise<never>((_, reject) => setTimeout(() => { const e: any = new Error('timeout'); e.timedOut = true; reject(e); }, timeoutMs)),
    ]);
  } catch (err: any) {
    const classified = classifyError(err, { provider: connection.type, model, timeoutMs, elapsedMs: Date.now() - startedMs });
    return { ok: false, error: { code: classified.code, message: classified.message } };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw.rawText);
  } catch (err: any) {
    return { ok: false, error: { code: 'parser_invalid_json', message: '图片解析结果不是合法 JSON：' + err.message } };
  }
  const schemaError = validateParsedImageEvidenceShape(parsed);
  if (schemaError) {
    return { ok: false, error: { code: 'parser_schema_invalid', message: schemaError } };
  }

  const result: ParsedImageEvidence = {
    evidenceId: input.evidenceId,
    contentType: parsed.contentType,
    source: parsed.source ?? null,
    context: parsed.context ?? null,
    extractedText: parsed.extractedText,
    entities: parsed.entities,
    relatedAssets: parsed.relatedAssets,
    observations: parsed.observations,
    uncertainFields: parsed.uncertainFields,
    parserConnectionId: connection.id,
    parserProvider: connection.type,
    parserModel: model,
    parsedAt: new Date().toISOString(),
  };
  saveCacheEntry(key, result);
  return { ok: true, result };
}
