export type SourceKey =
  | 'market' | 'technical' | 'macro' | 'news' | 'etf'
  | 'onchain' | 'sentiment' | 'derivatives' | 'stablecoin'
  | 'liquidation' | 'options';

export type Polarity = 'bullish' | 'bearish' | 'neutral';

/** One atomic fact/signal. Program-computed, not LLM-generated. */
export interface RawItem {
  id: string;
  label: string;
  /** Human-readable value string, already formatted (e.g. "62.4", "+1.24%", "看涨"). */
  value: string;
  polarity: Polarity;
  /** Optional longer context, kept short — this is what actually costs tokens downstream. */
  detail?: string;
  sourceUrl?: string;
  timestamp?: number;
}

export type SourceStatus = 'ok' | 'stub' | 'error';

export interface SourceResult {
  key: SourceKey;
  status: SourceStatus;
  fetchedAt: number;
  /** Everything the fetcher collected, before any weight-driven trimming ("多采集"). */
  itemsRaw: RawItem[];
  /** Why status is 'stub' or 'error' — e.g. "needs FRED_API_KEY". */
  note?: string;
}

export interface WeightConfig {
  key: SourceKey;
  weight: number; // 0-100
}

/** Result after weight-driven budgeting ("少输入"). This is what actually leaves the program layer. */
export interface BudgetedSourceResult {
  key: SourceKey;
  status: SourceStatus;
  weight: number;
  tokenBudget: number;
  itemsRawCount: number;
  itemsIncluded: RawItem[];
  itemsDroppedCount: number;
  tokensEstimated: number;
  /** True if both bullish and bearish items existed in itemsRaw and both survived trimming. */
  counterEvidencePreserved: boolean;
  note?: string;
}

/** The single consolidated envelope handed to the next phase (lightweight summarizer, then one main-model call). */
export interface ContextPackage {
  asset: string;
  generatedAt: number;
  totalTokenBudget: number;
  totalTokensEstimated: number;
  sources: BudgetedSourceResult[];
}
