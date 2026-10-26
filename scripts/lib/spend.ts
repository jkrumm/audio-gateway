/** Spend ledger + cap for the wave harnesses: list-price cost from a private usage ledger, enforced BEFORE every IU request. */
import { Database } from "bun:sqlite";

interface Rate {
  input?: number;
  cached?: number;
  /** Anthropic cache writes bill at 1.25x input. */
  cacheWriteFactor?: number;
  output?: number;
  perMinute?: number;
}

/** USD per 1M tokens, list price. Sources: platform.claude.com pricing; ai.google.dev pricing (Argon intro price through 2026-11-30, $4/$20 after); OpenAI figures for gpt-6.1-sol are provisional (snippet-level, research 2026-10-26). */
export const RATES: Record<string, Rate> = {
  "claude-opus-5-5": { input: 4, cached: 0.2, cacheWriteFactor: 1.25, output: 20 },
  "claude-sonnet-5-5": { input: 2, cached: 0.1, cacheWriteFactor: 1.25, output: 10 },
  "claude-haiku-5-5": { input: 0.1, cached: 0.01, cacheWriteFactor: 1.25, output: 0.5 },
  "gpt-6.1-sol": { input: 2, cached: 0.1, output: 10 },
  "gpt-6-luna": { input: 0.1, cached: 0.01, output: 0.5 },
  "gemini-4-argon": { input: 2, cached: 0.1, output: 10 },
  "gemini-3.8-flash": { input: 0.75, cached: 0.75, output: 3.75 },
  "deepseek-v4.1-flash": { input: 0.5, cached: 0.05, output: 1.5 },
  "gemini-3.8-flash-tts": { input: 0.5, output: 9 },
  "gemini-3.8-flash-lite-tts": { input: 0.5, output: 6 },
  "voxtral-mini-transcribe-3-0": { perMinute: 0.0035 },
};

export interface LedgerRow {
  id: number;
  endpoint: string;
  model: string;
  status: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_seconds: number | null;
  usage_json: string | null;
}

export function rowCost(row: LedgerRow): number {
  const rate = RATES[row.model.replace(/-eu$/, "")];
  if (!rate) return 0;
  if (rate.perMinute !== undefined) return ((row.audio_seconds ?? 0) / 60) * rate.perMinute;
  const usage = row.usage_json ? (JSON.parse(row.usage_json) as Record<string, unknown>) : {};
  const details = (usage["prompt_tokens_details"] ?? {}) as { cached_tokens?: number };
  const cacheRead = Number(usage["cache_read_input_tokens"] ?? details.cached_tokens ?? 0);
  const cacheWrite = Number(usage["cache_creation_input_tokens"] ?? 0);
  // Tool-loop rows carry only the raw usage object (OpenAI shape), no token columns.
  const input = row.input_tokens ?? Number(usage["prompt_tokens"] ?? 0);
  const output = row.output_tokens ?? Number(usage["completion_tokens"] ?? 0);
  const plain = Math.max(0, input - cacheRead - cacheWrite);
  return (
    (plain * (rate.input ?? 0) + cacheRead * (rate.cached ?? rate.input ?? 0) + cacheWrite * (rate.input ?? 0) * (rate.cacheWriteFactor ?? 1) + output * (rate.output ?? 0)) /
    1e6
  );
}

export class SpendLedger {
  private readonly db: Database;
  constructor(
    path: string,
    readonly capUsd: number,
    /** In-flight calls are not in the ledger yet; keep this much headroom so a parallel burst cannot pass the cap. */
    private readonly reserveUsd: number,
    /** Spend of this wave outside the ledger (probes, research jobs), counted against the same cap. */
    private readonly priorUsd = 0,
  ) {
    this.db = new Database(path, { create: true });
  }
  maxId(): number {
    return (this.db.query("SELECT COALESCE(MAX(id), 0) AS m FROM usage_record").get() as { m: number } | null)?.m ?? 0;
  }
  rows(afterId = 0, untilId = Number.MAX_SAFE_INTEGER): LedgerRow[] {
    return this.db
      .query("SELECT id, endpoint, model, status, latency_ms, input_tokens, output_tokens, audio_seconds, usage_json FROM usage_record WHERE id > ? AND id <= ? ORDER BY id")
      .all(afterId, untilId) as LedgerRow[];
  }
  cost(afterId = 0, untilId = Number.MAX_SAFE_INTEGER): number {
    return this.rows(afterId, untilId).reduce((n, r) => n + rowCost(r), 0);
  }
  spent(): number {
    return this.priorUsd + this.cost();
  }
  /** Throws when `estimateUsd` more would pass the cap (plus the in-flight reserve). */
  guard(estimateUsd = 0): void {
    const total = this.spent() + estimateUsd + this.reserveUsd;
    if (total > this.capUsd) throw new Error(`IU cap: $${this.spent().toFixed(2)} spent + $${estimateUsd.toFixed(2)} estimate + $${this.reserveUsd.toFixed(2)} reserve passes $${this.capUsd}`);
  }
  /** Every request to the IU host re-checks the cap first — a per-candidate check alone overran Wave 1. */
  installFetchGuard(iuHosts: string[]): void {
    const original = globalThis.fetch;
    const guarded = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (iuHosts.some((h) => url.includes(h))) this.guard();
      return original(input, init);
    }) as typeof fetch;
    globalThis.fetch = guarded;
  }
}
