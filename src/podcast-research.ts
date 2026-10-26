/**
 * The research stage of the v2 podcast pipeline (docs/podcast-editorial-room.md
 * §1): a tool-calling loop that reads the listener's own material, gives the
 * writers' room eyes on the brain and past episodes, and spends a small,
 * budgeted amount of research-gateway calls on what's genuinely missing.
 * Best-effort by design — the caller decides whether to run this stage at
 * all and what to do when it throws (see the spec: proceed without a dossier).
 */
import { isAbsolute, join, relative, resolve } from "node:path";
import { readdir, readFile, realpath } from "node:fs/promises";
import { rawFetch } from "./gemini-tts";
import { runToolLoop, type ToolDef, type ToolLoopFetch } from "./llm-tools";
import { log } from "./log";
import { repairGermanQuotes } from "./podcast-script";
import type { Dossier, EpisodeHistory } from "./podcast-types";

export interface ResearchInput {
  source: string;
  brief?: string;
  title?: string;
  language: "de" | "en";
  series: string;
}

export interface ResearchDeps {
  /** Empty/undefined → no brain tools. */
  brainDir?: string;
  /** Undefined → no research tool. */
  research?: { url: string; apiKey: string; /** Optional emergency valve on runs per job; undefined = unlimited (quality over cost — no per-episode ceiling). */ maxCalls?: number };
  /** Running research-gateway spend of this job, recorded for visibility only (profile) — never a ceiling. Created by `runPodcastResearch` when absent. */
  spend?: { usd: number };
  history: EpisodeHistory;
  model: string;
  /** Top-level `reasoning_effort` for `model`, already resolved via `resolveReasoningEffort`; omitted entirely when unset. */
  reasoningEffort?: string;
  /** Default `rawFetch`; tests inject a fake with the same `(url, init) => Promise<RawResponse>` shape. */
  fetchImpl?: ToolLoopFetch;
  /** Sleep between research-gateway polls, injectable for tests. Default 10_000 ms. */
  pollIntervalMs?: number;
}

/** How often the still-`queued`/`running` poll loop logs a heartbeat, so a human tailing logs sees it's alive. Not a cap — see `researchTool`. */
const RESEARCH_POLL_LOG_INTERVAL_MS = 60 * 1000;
const BRAIN_READ_MAX_CHARS = 60_000;
const PAST_TRANSCRIPT_MAX_CHARS = 40_000;
const RESEARCH_REPORT_MAX_CHARS = 20_000;
const DEFAULT_SEARCH_LIMIT = 8;
const DEFAULT_PAST_EPISODES_LIMIT = 10;
const DEFAULT_POLL_INTERVAL_MS = 10_000;

// ---------------------------------------------------------------------------
// Vault access — path containment, frontmatter, search
// ---------------------------------------------------------------------------

/**
 * `.md` only, and no path segment may start with "." — blocks `.obsidian/...`,
 * a bare `.env`, or any hidden directory nested deeper in the vault. The one
 * containment predicate shared by `resolveInVault` (single-file reads —
 * `brain_read`, `readBrainNotes`) and `walkMarkdown` (the `brain_search`
 * directory walk).
 */
function isAllowedVaultRelPath(relPath: string): boolean {
  const segments = relPath.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment.startsWith("."))) return false;
  return relPath.toLowerCase().endsWith(".md");
}

/** Resolve a vault-relative path inside `brainDir`, rejecting `..`, absolute paths, symlink escapes, non-`.md` files and hidden path segments. */
async function resolveInVault(brainDir: string, relPath: string): Promise<string> {
  if (isAbsolute(relPath)) throw new Error(`path must be relative to the vault: "${relPath}"`);
  const resolved = resolve(brainDir, relPath);
  const rel = relative(brainDir, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`path escapes the vault: "${relPath}"`);
  if (!isAllowedVaultRelPath(rel)) throw new Error(`only markdown files outside hidden directories may be read: "${relPath}"`);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new Error(`not found: "${relPath}"`);
  }
  const realBrainDir = await realpath(brainDir);
  const realRel = relative(realBrainDir, real);
  if (realRel.startsWith("..") || isAbsolute(realRel)) throw new Error(`path escapes the vault: "${relPath}"`);
  return real;
}

/** Tolerant `key: value` frontmatter scan — no YAML lists/nesting, just what brain_search/brain_read need. */
function parseFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return { frontmatter, body: raw.slice(match[0].length) };
}

async function walkMarkdown(dir: string, root: string = dir): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkMarkdown(full, root)));
    } else if (entry.isFile() && isAllowedVaultRelPath(relative(root, full))) {
      out.push(full);
    }
  }
  return out;
}

/** Lowercase, split on non-letters (German umlauts kept), drop tokens shorter than 3 chars. */
function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-zäöüß]+/i)
    .filter((t) => t.length >= 3);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function buildSnippet(body: string, hitIndex: number): string {
  if (hitIndex === -1) return body.slice(0, 240).trim();
  const start = Math.max(0, hitIndex - 100);
  const end = Math.min(body.length, hitIndex + 140);
  return body.slice(start, end).trim();
}

interface BrainSearchHit {
  path: string;
  title: string;
  description: string;
  snippet: string;
  score: number;
}

async function searchBrain(brainDir: string, query: string, limit: number): Promise<BrainSearchHit[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const files = await walkMarkdown(brainDir);
  const results: BrainSearchHit[] = [];
  for (const file of files) {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const relPath = relative(brainDir, file);
    const { frontmatter, body } = parseFrontmatter(raw);
    const lowerBody = body.toLowerCase();
    const lowerPath = relPath.toLowerCase();
    let score = 0;
    let firstHitIndex = -1;
    for (const term of tokens) {
      const bodyHits = countOccurrences(lowerBody, term);
      score += Math.min(20, bodyHits);
      score += 5 * countOccurrences(lowerPath, term);
      if (firstHitIndex === -1 && bodyHits > 0) firstHitIndex = lowerBody.indexOf(term);
    }
    if (score <= 0) continue;
    results.push({
      path: relPath,
      title: frontmatter["title"] ?? relPath,
      description: frontmatter["description"] ?? "",
      snippet: buildSnippet(body, firstHitIndex),
      score,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/** Read brain-relative note paths (`request.sourcePaths`) up front so the caller can append them to `source`. */
export async function readBrainNotes(brainDir: string, paths: string[]): Promise<Array<{ path: string; text: string }>> {
  const out: Array<{ path: string; text: string }> = [];
  for (const path of paths) {
    const real = await resolveInVault(brainDir, path);
    const text = await readFile(real, "utf8");
    out.push({ path, text });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function brainSearchTool(brainDir: string): ToolDef {
  return {
    name: "brain_search",
    description: "Search the listener's second-brain vault for notes matching a query. Returns the best-scoring notes with a snippet.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search terms." },
        limit: { type: "number", description: "Max results, default 8." },
      },
      required: ["query"],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { query: string; limit?: number };
      const results = await searchBrain(brainDir, args.query, args.limit ?? DEFAULT_SEARCH_LIMIT);
      return JSON.stringify(results);
    },
  };
}

function brainReadTool(brainDir: string): ToolDef {
  return {
    name: "brain_read",
    description: "Read one note from the listener's vault by its vault-relative path (as returned by brain_search).",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { path: string };
      const real = await resolveInVault(brainDir, args.path);
      const raw = await readFile(real, "utf8");
      const { frontmatter, body } = parseFrontmatter(raw);
      const truncated = body.length > BRAIN_READ_MAX_CHARS;
      const cappedBody = truncated ? `${body.slice(0, BRAIN_READ_MAX_CHARS)}\n\n[truncated at ${BRAIN_READ_MAX_CHARS} chars]` : body;
      return JSON.stringify({ path: args.path, frontmatter, body: cappedBody });
    },
  };
}

function pastEpisodesTool(history: EpisodeHistory): ToolDef {
  return {
    name: "past_episodes",
    description: "List recent finished episodes of this podcast, newest first, with their editorial profile.",
    parameters: {
      type: "object",
      properties: { limit: { type: "number", description: "Max episodes, default 10." } },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { limit?: number };
      return JSON.stringify(history.recent(args.limit ?? DEFAULT_PAST_EPISODES_LIMIT));
    },
  };
}

function pastTranscriptTool(history: EpisodeHistory): ToolDef {
  return {
    name: "past_transcript",
    description: "Read the full markdown transcript of a past episode by its id (from past_episodes).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { id: string };
      const transcript = history.transcript(args.id);
      if (transcript == null) return `error: no transcript found for episode "${args.id}"`;
      return transcript.length > PAST_TRANSCRIPT_MAX_CHARS
        ? `${transcript.slice(0, PAST_TRANSCRIPT_MAX_CHARS)}\n\n[truncated at ${PAST_TRANSCRIPT_MAX_CHARS} chars]`
        : transcript;
    },
  };
}

interface ResearchGatewaySubmitResponse {
  jobId: string;
}

interface ResearchGatewayPollResponse {
  status: string;
  result?: { report?: string; sources?: string[]; cost?: { totalUsd?: number } };
  error?: string;
}

function researchTool(research: NonNullable<ResearchDeps["research"]>, spend: { usd: number }, fetchImpl: ToolLoopFetch, pollIntervalMs: number): ToolDef {
  let used = 0;
  /** An identical query returns what it returned the first time — no second run, no second charge. */
  const answered = new Map<string, string>();
  const normalize = (q: string): string => q.toLowerCase().replace(/\s+/g, " ").trim();
  const headers = { Authorization: `Bearer ${research.apiKey}`, "content-type": "application/json" };
  return {
    name: "research",
    description:
      "Web research through the research gateway — EXPECTED, not a last resort, for anything the listener needs that the SOURCE and the brain do not explain: the external third-party names, projects, tools, companies and standards the notes take for granted (batch them in ONE query asking for one plain sentence each: what it is and what it is for here), facts the episode hinges on, current numbers, and the claims the notes make about the outside world. Several runs per episode are normal; keep each query specific and distinct (an identical query is not run twice).",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        depth: { type: "string", enum: ["quick", "standard"], description: "Default quick." },
      },
      required: ["query"],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as { query: string; depth?: string };
      if (args.depth !== undefined && args.depth !== "quick" && args.depth !== "standard") {
        return `error: invalid depth "${args.depth}", expected "quick" or "standard"`;
      }
      const depth = args.depth ?? "quick";
      const key = normalize(args.query);
      const earlier = answered.get(key);
      if (earlier !== undefined) return `(this exact query was already run — same result)\n${earlier}`;
      if (research.maxCalls !== undefined && used >= research.maxCalls) return `research budget exhausted (${research.maxCalls} calls)`;

      const submitRes = await fetchImpl(`${research.url}/research/`, {
        method: "POST",
        headers,
        body: JSON.stringify({ query: args.query, depth }),
      });
      if (submitRes.status === 429) return "research queue full, try later";
      if (submitRes.status < 200 || submitRes.status >= 300) {
        return `error: research submit failed HTTP ${submitRes.status} ${submitRes.body.slice(0, 300)}`;
      }
      // Debited only once the gateway actually accepted the job — a 429, a
      // transport error, or any other non-2xx must not consume a slot.
      used++;
      const { jobId } = JSON.parse(submitRes.body) as ResearchGatewaySubmitResponse;

      // Unbounded wait — research-gateway itself no longer time-caps a job, so a
      // healthy deep job may legitimately run well past any number picked here. The
      // gateway's own heartbeat reaping (job-store.ts) already turns a stalled/dead
      // job into a terminal "error" status, so this loop only needs to keep polling
      // until the job reaches a terminal state and log a heartbeat so a human tailing
      // logs can see it's still alive.
      const startedAt = Date.now();
      let lastLoggedAt = startedAt;
      while (true) {
        const pollRes = await fetchImpl(`${research.url}/research/${jobId}`, { method: "GET", headers });
        if (pollRes.status < 200 || pollRes.status >= 300) {
          return `error: research poll failed HTTP ${pollRes.status} ${pollRes.body.slice(0, 300)}`;
        }
        const parsed = JSON.parse(pollRes.body) as ResearchGatewayPollResponse;
        if (parsed.status === "done") {
          const report = (parsed.result?.report ?? "").slice(0, RESEARCH_REPORT_MAX_CHARS);
          const sources = parsed.result?.sources ?? [];
          const sourcesBlock = sources.length > 0 ? `\n\nSources:\n${sources.map((s) => `- ${s}`).join("\n")}` : "";
          spend.usd += parsed.result?.cost?.totalUsd ?? 0;
          const answer = `${report}${sourcesBlock}`;
          answered.set(key, answer);
          return answer;
        }
        if (parsed.status === "failed" || parsed.status === "error") {
          return `error: research failed: ${parsed.error ?? "unknown error"}`;
        }
        const now = Date.now();
        if (now - lastLoggedAt >= RESEARCH_POLL_LOG_INTERVAL_MS) {
          log.info("podcast research: still waiting on research-gateway job", { jobId, status: parsed.status, waitedMs: now - startedAt });
          lastLoggedAt = now;
        }
        await Bun.sleep(pollIntervalMs);
      }
    },
  };
}

/** Exported for tests. */
export function buildResearchTools(deps: ResearchDeps): ToolDef[] {
  const tools: ToolDef[] = [];
  if (deps.brainDir) {
    tools.push(brainSearchTool(deps.brainDir));
    tools.push(brainReadTool(deps.brainDir));
  }
  tools.push(pastEpisodesTool(deps.history));
  tools.push(pastTranscriptTool(deps.history));
  if (deps.research) {
    tools.push(researchTool(deps.research, (deps.spend ??= { usd: 0 }), deps.fetchImpl ?? rawFetch, deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS));
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Dossier parsing
// ---------------------------------------------------------------------------

/** Pulls a JSON object out of a reply that may be fenced in a markdown code block or carry stray prose around it. */
function extractJsonObject(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fenced ? fenced[1] : raw)?.trim() ?? "";
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return candidate.slice(start, end + 1);
}

function stringField(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Tolerant: missing arrays become `[]`, strings are trimmed. Throws only if no JSON object can be found at all. */
export function parseDossier(raw: string): Dossier {
  const jsonText = extractJsonObject(raw);
  if (!jsonText) throw new Error("no JSON object found in research dossier response");
  const parsed = JSON.parse(repairGermanQuotes(jsonText)) as Record<string, unknown>;

  const additions = Array.isArray(parsed["additions"])
    ? (parsed["additions"] as unknown[]).map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>;
        return { source: stringField(obj, "source"), text: stringField(obj, "text") };
      })
    : [];
  const glossary = Array.isArray(parsed["glossary"])
    ? (parsed["glossary"] as unknown[]).map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>;
        return { term: stringField(obj, "term"), plain: stringField(obj, "plain") };
      })
    : [];
  const priorCoverage = Array.isArray(parsed["priorCoverage"])
    ? (parsed["priorCoverage"] as unknown[]).map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>;
        return { episodeId: stringField(obj, "episodeId"), title: stringField(obj, "title"), covered: stringField(obj, "covered") };
      })
    : [];
  const openQuestions = Array.isArray(parsed["openQuestions"])
    ? (parsed["openQuestions"] as unknown[]).map((q) => (typeof q === "string" ? q.trim() : String(q)))
    : [];

  return {
    summary: stringField(parsed, "summary"),
    additions,
    glossary,
    priorCoverage,
    openQuestions,
    toolCalls: [],
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function buildSystemPrompt(input: ResearchInput, deps: ResearchDeps): string {
  const languageName = input.language === "de" ? "German" : "English";
  const notes: string[] = [];
  if (!deps.brainDir) notes.push("The listener's brain (brain_search/brain_read) is not configured for this run — those tools are absent.");
  if (!deps.research) notes.push("The research gateway (the `research` tool) is not configured for this run — it is absent.");
  const availability = notes.length > 0 ? `\n\n${notes.join("\n")}` : "";

  return `You are the researcher of "${input.series}", a two-host podcast in ${languageName} that turns the listener's own notes into an episode.

The SOURCE is the listener's material and stays verbatim for the writers — your job is to make the writers' room UNDERSTAND it and to bring what they lack: context from the listener's brain (search it for the topic and adjacent notes, read what matters), what previous episodes already covered (so they don't repeat it), and the outside world. The listener's recurring failure is EXTERNAL NAMES nobody explains — third-party projects, tools, companies, standards and acronyms the notes take for granted (the notes' author knows them, a listener does not). So: first list every such name in the SOURCE that neither the SOURCE itself nor the brain notes you read explain, then look them up with ONE batched \`research\` query (all names in one question, asking for one plain sentence each: what it is and what it is for here). Web research is expected, not a last resort: follow with further, distinct runs for every fact the episode hinges on, every claim the notes make about the outside world that you cannot confirm from the brain, and every name the first run left unclear. Every proper name, place or term a listener would not know goes into the glossary with a plain-words handle — the glossary is built from what the brain and the research found, never from your guess; a name you could not resolve is glossed with only what the SOURCE implies. There is no research budget to ration — quality first — but batch the names, never one call per name, never the same query twice.

Finish with STRICT JSON and nothing else, matching exactly this shape:
{"summary":"…","additions":[{"source":"brain: <path>"|"research: <query>"|"episode: <id>","text":"…"}],"glossary":[{"term":"…","plain":"…"}],"priorCoverage":[{"episodeId":"…","title":"…","covered":"…"}],"openQuestions":["…"]}${availability}`;
}

function buildUserContent(input: ResearchInput): string {
  const parts = [`SOURCE:\n${input.source}`];
  if (input.brief) parts.push(`BRIEF:\n${input.brief}`);
  if (input.title) parts.push(`TITLE HINT:\n${input.title}`);
  return parts.join("\n\n");
}

/** Run the research stage; rethrows on failure — the caller decides to proceed without a dossier. */
export async function runPodcastResearch(input: ResearchInput, deps: ResearchDeps): Promise<Dossier> {
  const spend = (deps.spend ??= { usd: 0 });
  const tools = buildResearchTools(deps);
  const result = await runToolLoop({
    model: deps.model,
    systemPrompt: buildSystemPrompt(input, deps),
    userContent: buildUserContent(input),
    tools,
    // Was a fixed 8000 (gpt-5.6-terra); deepseek-v4.1-flash's reasoning at
    // `high` effort spends generously against the same budget, and a
    // budget-starved round now retries with double before throwing
    // (llm-tools.ts) rather than silently returning "" — 32000 gives that
    // retry real headroom instead of doubling from an already-tight number.
    maxCompletionTokens: 32000,
    stage: "research",
    usageEndpoint: "podcast-research",
    reasoningEffort: deps.reasoningEffort,
    fetchImpl: deps.fetchImpl,
  });
  let dossier: Dossier;
  try {
    dossier = parseDossier(result.content);
  } catch (err) {
    // The research already ran (and cost money): ask once for the same content as valid JSON rather than losing the dossier.
    log.warn("research dossier did not parse, asking for a JSON repair", { error: err instanceof Error ? err.message : String(err), chars: result.content.length, raw: result.content.slice(0, 6000) });
    const fixed = await runToolLoop({
      model: deps.model,
      systemPrompt: "You repair JSON. The user message is a research dossier that should be ONE valid JSON object but is not (unescaped quotes inside strings, stray prose, a cut-off tail). Return the SAME content as a single valid JSON object — escape inner quotes, keep every entry, add nothing — and nothing else.",
      userContent: result.content,
      tools: [],
      maxCompletionTokens: 32000,
      stage: "research",
      usageEndpoint: "podcast-research",
      reasoningEffort: deps.reasoningEffort,
      fetchImpl: deps.fetchImpl,
    });
    dossier = parseDossier(fixed.content);
  }
  return { ...dossier, toolCalls: result.calls, researchUsd: spend.usd };
}
