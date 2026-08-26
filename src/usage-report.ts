/**
 * Pure parsing/rollup functions for the `usage:tail` CLI (scripts/usage-tail.ts).
 * No SQLite, no network — takes plain rows shaped like `usage_record`, so this
 * module is hermetically testable and the script stays a thin I/O wrapper.
 */

/** Row shape as read straight off `usage_record` (snake_case, matches the SQLite columns). */
export interface UsageDbRow {
  id: number;
  ts: string;
  endpoint: string;
  model: string;
  status: number;
  latency_ms: number;
  response_format: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  audio_tokens: number | null;
  audio_seconds: number | null;
  input_chars: number | null;
  bytes_out: number | null;
  usage_json: string | null;
  error_text: string | null;
  request_id: string | null;
  caller: string | null;
  text_json: string | null;
}

const REQUEST_ENDPOINTS = new Set(["speech-request", "transcription-request"]);
const PREP_ENDPOINTS = new Set(["speech-prep", "speech-summary"]);

interface SpeechUsageJson {
  mode?: string | null;
  lane?: string | null;
  chunks?: number | null;
  language_code?: string | null;
  voice?: string | null;
  title?: string | null;
}

interface TextJson {
  input?: string;
  output?: string;
}

/** One reviewable line: a `*-request` summary row joined with its detail rows by request_id. */
export interface RequestLine {
  id: number;
  ts: string;
  endpoint: "speech-request" | "transcription-request";
  requestId: string | null;
  caller: string | null;
  model: string;
  status: number;
  error: boolean;
  totalLatencyMs: number;
  mode: string | null;
  lane: string | null;
  chunks: number | null;
  languageCode: string | null;
  voice: string | null;
  title: string | null;
  inputChars: number | null;
  outputChars: number | null;
  audioSeconds: number | null;
  bytesOut: number | null;
  inputSnippet: string | null;
  outputSnippet: string | null;
  /** Wall-clock estimates derived by joining sibling rows on request_id. */
  prepMs: number | null;
  synthMs: number | null;
  sttMs: number | null;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Join `*-request` summary rows with their sibling detail rows (same
 * request_id) into one reviewable line per HTTP request. Rows without a
 * request_id (pre-correlation history, or a lane called directly in a test)
 * are skipped — there is nothing to join them to.
 */
export function buildRequestLines(rows: UsageDbRow[]): RequestLine[] {
  const byRequestId = new Map<string, UsageDbRow[]>();
  for (const row of rows) {
    if (!row.request_id) continue;
    const bucket = byRequestId.get(row.request_id);
    if (bucket) bucket.push(row);
    else byRequestId.set(row.request_id, [row]);
  }

  const lines: RequestLine[] = [];
  for (const row of rows) {
    if (!REQUEST_ENDPOINTS.has(row.endpoint)) continue;

    const siblings = row.request_id ? (byRequestId.get(row.request_id) ?? []) : [];
    const prepRows = siblings.filter((r) => PREP_ENDPOINTS.has(r.endpoint));
    const synthRows = siblings.filter((r) => r.endpoint === "speech");
    const sttRows = siblings.filter((r) => r.endpoint === "transcriptions");

    const usage = parseJson<SpeechUsageJson>(row.usage_json);
    const text = parseJson<TextJson>(row.text_json);

    lines.push({
      id: row.id,
      ts: row.ts,
      endpoint: row.endpoint as "speech-request" | "transcription-request",
      requestId: row.request_id,
      caller: row.caller,
      model: row.model,
      status: row.status,
      error: row.status >= 400,
      totalLatencyMs: row.latency_ms,
      mode: usage?.mode ?? null,
      lane: usage?.lane ?? null,
      chunks: usage?.chunks ?? (synthRows.length || null),
      languageCode: usage?.language_code ?? null,
      voice: usage?.voice ?? null,
      title: usage?.title ?? null,
      inputChars: row.input_chars,
      outputChars: text?.output?.length ?? null,
      audioSeconds: row.audio_seconds,
      bytesOut: row.bytes_out,
      inputSnippet: text?.input ?? null,
      outputSnippet: text?.output ?? null,
      prepMs: prepRows.length > 0 ? prepRows.reduce((sum, r) => sum + r.latency_ms, 0) : null,
      // Chunks synthesize concurrently (bounded by TTS_CONCURRENCY) — the max
      // per-chunk latency approximates the synth stage's wall-clock time far
      // better than summing them.
      synthMs: synthRows.length > 0 ? Math.max(...synthRows.map((r) => r.latency_ms)) : null,
      sttMs: sttRows.length > 0 ? sttRows.reduce((sum, r) => sum + r.latency_ms, 0) : null,
    });
  }

  return lines;
}

/** Rollup key: lane/mode for speech requests, "transcription" for STT requests. */
export function rollupKey(line: RequestLine): string {
  if (line.endpoint === "transcription-request") return "transcription";
  return `${line.lane ?? "unknown"}/${line.mode ?? "unknown"}`;
}

export interface Rollup {
  key: string;
  count: number;
  errorCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgAudioSeconds: number | null;
  languageSplit: Record<string, number>;
}

/** Nearest-rank percentile over a (not-yet-sorted) list of numbers. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] ?? 0;
}

/** Per-lane/mode rollup over a window of request lines: count, latency percentiles, errors, audio, language split. */
export function computeRollups(lines: RequestLine[]): Rollup[] {
  const groups = new Map<string, RequestLine[]>();
  for (const line of lines) {
    const key = rollupKey(line);
    const bucket = groups.get(key);
    if (bucket) bucket.push(line);
    else groups.set(key, [line]);
  }

  const rollups: Rollup[] = [];
  for (const [key, group] of groups) {
    const latencies = group.map((l) => l.totalLatencyMs);
    const audioSeconds = group.map((l) => l.audioSeconds).filter((s): s is number => s !== null);
    const languageSplit: Record<string, number> = {};
    for (const line of group) {
      const lang = line.languageCode ?? "unknown";
      languageSplit[lang] = (languageSplit[lang] ?? 0) + 1;
    }

    rollups.push({
      key,
      count: group.length,
      errorCount: group.filter((l) => l.error).length,
      p50LatencyMs: percentile(latencies, 50),
      p95LatencyMs: percentile(latencies, 95),
      avgAudioSeconds: audioSeconds.length > 0 ? audioSeconds.reduce((a, b) => a + b, 0) / audioSeconds.length : null,
      languageSplit,
    });
  }

  return rollups.sort((a, b) => b.count - a.count);
}

const RELATIVE_SINCE = /^(\d+)(m|h|d)$/;
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Parse `--since`: a relative duration (`30m`/`2h`/`1d`) or an ISO date string. */
export function parseSince(raw: string, now: Date = new Date()): Date {
  const match = RELATIVE_SINCE.exec(raw);
  if (match) {
    const amount = Number(match[1]);
    const unit = match[2] as string;
    return new Date(now.getTime() - amount * UNIT_MS[unit]!);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid --since value: ${raw}`);
  return parsed;
}

const fmtSeconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

function quoteSnippet(text: string | null, max = 60): string | null {
  if (!text) return null;
  const oneLine = text.replace(/\s+/g, " ").trim();
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  return `"${clipped}"`;
}

/** Format one local-time, single-line summary of a request — the body of `usage:tail`'s output. */
export function formatLine(line: RequestLine): string {
  const time = new Date(line.ts).toLocaleTimeString();
  const statusTag = line.error ? ` [${line.status}]` : "";

  if (line.endpoint === "transcription-request") {
    const audio = line.audioSeconds !== null ? `${fmtSeconds(line.audioSeconds * 1000)} audio` : "audio n/a";
    const snippet = quoteSnippet(line.outputSnippet);
    return [
      time,
      "transcription",
      line.model,
      `${fmtSeconds(line.totalLatencyMs)}${statusTag}`,
      audio,
      snippet ? `▸ ${snippet}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join("  ");
  }

  const chars =
    line.inputChars !== null && line.outputChars !== null ? `${line.inputChars}ch→${line.outputChars}ch` : null;
  const stageParts = [
    line.prepMs !== null ? `prep ${fmtSeconds(line.prepMs)}` : null,
    line.synthMs !== null ? `synth ${fmtSeconds(line.synthMs)}` : null,
    line.chunks !== null ? `${line.chunks} chunk${line.chunks === 1 ? "" : "s"}` : null,
  ].filter((part): part is string => part !== null);
  const snippet = quoteSnippet(line.outputSnippet ?? line.inputSnippet);

  return [
    time,
    "speech",
    line.mode ?? "-",
    line.model,
    line.languageCode,
    line.voice,
    chars,
    `${fmtSeconds(line.totalLatencyMs)} total${statusTag}`,
    stageParts.length > 0 ? `(${stageParts.join(" · ")})` : null,
    snippet ? `▸ ${snippet}` : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join("  ");
}

/** Format the footer rollup table (one line per lane/mode group). */
export function formatRollup(rollup: Rollup): string {
  const languages = Object.entries(rollup.languageSplit)
    .sort((a, b) => b[1] - a[1])
    .map(([lang, count]) => `${lang}:${count}`)
    .join(" ");
  const audio = rollup.avgAudioSeconds !== null ? `avg audio ${rollup.avgAudioSeconds.toFixed(1)}s` : "avg audio n/a";
  return [
    rollup.key.padEnd(20),
    `n=${rollup.count}`,
    `errors=${rollup.errorCount}`,
    `p50=${fmtSeconds(rollup.p50LatencyMs)}`,
    `p95=${fmtSeconds(rollup.p95LatencyMs)}`,
    audio,
    languages ? `lang[${languages}]` : null,
  ]
    .filter((part): part is string => part !== null)
    .join("  ");
}
