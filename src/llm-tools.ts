/**
 * A generic OpenAI-dialect tool-calling loop over `fetch`, shared by every
 * podcast v2 stage that needs the model to call tools (currently the
 * researcher, `podcast-research.ts`). Non-streaming on purpose: a tool-calling
 * round needs the assistant message's `tool_calls` array intact (including
 * whatever provider-specific fields ride along with it, e.g. Gemini's
 * `extra_content.google.thought_signature` on the IU compat route), which is
 * far simpler to get right from one JSON body than by re-assembling deltas.
 *
 * The loop echoes the assistant message it received back into `messages`
 * UNCHANGED — never rebuilt from parsed fields — because a provider that
 * smuggles state through opaque extra fields will 503 the next request if
 * that state doesn't round-trip. See docs/podcast-editorial-room.md Decision 4.
 */
import { rawFetch, type RawResponse } from "./gemini-tts";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { withSpan } from "./otel";
import type { ToolCallRecord } from "./podcast-types";
import { recordUsage, type UsageRow } from "./usage";

/**
 * Idle guard for a single (non-streaming) model round — not a step/round cap.
 * Agent workers have no turn or wall-clock ceiling (`~/.claude/rules/agent-limits.md`);
 * the researcher loop ends only when the model concludes on its own. `callChat` is
 * non-streaming, so nothing can watch tokens inside one round — this is a hang guard
 * on a single request, sized so a reasoning model on a hard round never trips it
 * (the rule's real answer is streaming + idle; 30 min is the floor until then).
 */
const ROUND_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface ToolDef<A = unknown> {
  name: string;
  description: string;
  /** JSON Schema object for the arguments. */
  parameters: Record<string, unknown>;
  /** Returns the tool result as a string the model reads. Throwing is turned into an error string result; the loop keeps going. */
  execute: (args: A) => Promise<string>;
}

/** Shape of the injectable fetch — matches `rawFetch`, not the raw global `fetch` (tests script `RawResponse`s directly). */
export type ToolLoopFetch = typeof rawFetch;

export interface ToolLoopParams {
  model: string;
  systemPrompt: string;
  userContent: string;
  tools: ToolDef[];
  maxCompletionTokens: number;
  /** Span attribute `audio.podcast.stage` (e.g. "research"). */
  stage: string;
  /** Usage row endpoint (e.g. "podcast-research"). */
  usageEndpoint: string;
  /** Default `rawFetch` (tests inject a fake with the same `(url, init) => Promise<RawResponse>` shape). */
  fetchImpl?: ToolLoopFetch;
  /** Abort a round whose (non-streaming) model call produces nothing within this window. Default 30 min (a hang guard, not a budget); tests override. */
  roundIdleTimeoutMs?: number;
}

export interface ToolLoopResult {
  content: string;
  calls: ToolCallRecord[];
  rounds: number;
}

interface ToolCallRequest {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** The assistant/tool/user/system message as it round-trips through `messages` — deliberately loose so unknown fields survive. */
interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: ToolCallRequest[];
  tool_call_id?: string;
  [key: string]: unknown;
}

interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: ChatMessage; finish_reason?: string }>;
  usage?: OpenAiUsage;
}

function toolSchemas(tools: ToolDef[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

async function callChat(params: {
  model: string;
  messages: ChatMessage[];
  tools: ToolDef[];
  maxCompletionTokens: number;
  stage: string;
  round: number;
  usageEndpoint: string;
  fetchImpl: ToolLoopFetch;
}): Promise<{ message: ChatMessage; finishReason?: string }> {
  return withSpan(
    "audio.podcast.llm",
    {
      "llm.model": params.model,
      "audio.podcast.stage": params.stage,
      "audio.podcast.round": params.round,
    },
    async (span) => {
      const start = Date.now();
      const body: Record<string, unknown> = {
        model: params.model,
        messages: params.messages,
        max_completion_tokens: params.maxCompletionTokens,
      };
      if (params.tools.length > 0) body["tools"] = toolSchemas(params.tools);

      let res: RawResponse;
      try {
        res = await params.fetchImpl(iuUrl("/chat/completions"), {
          method: "POST",
          headers: iuHeaders({ "content-type": "application/json" }),
          body: JSON.stringify(body),
        });
      } catch (err) {
        const latencyMs = Date.now() - start;
        const message = err instanceof Error ? err.message : String(err);
        log.error("podcast tool loop transport error", { endpoint: params.usageEndpoint, model: params.model, stage: params.stage, latencyMs, error: message });
        throw err;
      }
      const latencyMs = Date.now() - start;
      span.setAttributes({ "http.status_code": res.status });

      if (res.status < 200 || res.status >= 300) {
        const errorText = res.body.slice(0, 500);
        log.error("podcast tool loop llm error", { endpoint: params.usageEndpoint, model: params.model, stage: params.stage, status: res.status, latencyMs, error: errorText });
        recordUsage({ endpoint: params.usageEndpoint as UsageRow["endpoint"], model: params.model, status: res.status, latencyMs, errorText });
        throw new Error(`Podcast ${params.stage} tool loop failed: HTTP ${res.status} ${res.body.slice(0, 300)}`);
      }

      const parsed = JSON.parse(res.body) as ChatCompletionResponse;
      const message = parsed.choices?.[0]?.message ?? { role: "assistant", content: "" };
      const finishReason = parsed.choices?.[0]?.finish_reason;
      recordUsage({
        endpoint: params.usageEndpoint as UsageRow["endpoint"],
        model: params.model,
        status: res.status,
        latencyMs,
        usageJson: { ...parsed.usage, finish_reason: finishReason ?? null },
      });
      span.setAttributes({
        "llm.output_tokens": parsed.usage?.completion_tokens ?? undefined,
        ...(finishReason && { "llm.finish_reason": finishReason }),
      });
      return { message, finishReason };
    },
    "client",
  );
}

async function runTool(tool: ToolDef, call: ToolCallRequest): Promise<{ content: string; record: ToolCallRecord }> {
  let args: unknown;
  try {
    args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: `error: invalid arguments JSON for tool "${tool.name}": ${message}`,
      record: { tool: tool.name, args: call.function.arguments, ok: false, ms: 0 },
    };
  }

  const start = Date.now();
  return withSpan("audio.podcast.tool", { "tool.name": tool.name }, async (span) => {
    try {
      const content = await tool.execute(args);
      const ms = Date.now() - start;
      span.setAttributes({ "tool.name": tool.name, "tool.ok": true, "tool.ms": ms });
      return { content, record: { tool: tool.name, args, ok: true, ms } };
    } catch (err) {
      const ms = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);
      span.setAttributes({ "tool.name": tool.name, "tool.ok": false, "tool.ms": ms });
      span.setStatus("error", message);
      return { content: `error: ${message}`, record: { tool: tool.name, args, ok: false, ms } };
    }
  });
}

/**
 * Race one `callChat` round against an idle timer — a round that produces nothing
 * within `idleTimeoutMs` aborts the whole loop rather than hanging it forever.
 */
async function callChatWithIdleGuard(
  params: Parameters<typeof callChat>[0],
  idleTimeoutMs: number,
): Promise<{ message: ChatMessage; finishReason?: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Podcast ${params.stage} tool loop round ${params.round} produced no response for ${Math.round(idleTimeoutMs / 60_000)} minutes`));
    }, idleTimeoutMs);
  });
  try {
    return await Promise.race([callChat(params), idle]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a full tool-calling round trip: system + user message, then rounds of
 * assistant tool calls executed sequentially, until the model answers with no
 * tool call — no round cap; agent workers have no turn ceiling
 * (`~/.claude/rules/agent-limits.md`). Each round's (non-streaming) model call is
 * hang-guarded (default 30 min, see `ROUND_IDLE_TIMEOUT_MS`) so a stuck round
 * aborts the loop instead of hanging it forever.
 */
export async function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const fetchImpl = params.fetchImpl ?? rawFetch;
  const idleTimeoutMs = params.roundIdleTimeoutMs ?? ROUND_IDLE_TIMEOUT_MS;
  const toolsByName = new Map(params.tools.map((t) => [t.name, t] as const));
  const messages: ChatMessage[] = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userContent },
  ];
  const calls: ToolCallRecord[] = [];

  for (let round = 1; ; round++) {
    const { message } = await callChatWithIdleGuard(
      {
        model: params.model,
        messages,
        tools: params.tools,
        maxCompletionTokens: params.maxCompletionTokens,
        stage: params.stage,
        round,
        usageEndpoint: params.usageEndpoint,
        fetchImpl,
      },
      idleTimeoutMs,
    );

    if (!message.tool_calls || message.tool_calls.length === 0) {
      return { content: message.content ?? "", calls, rounds: round };
    }

    // Push the assistant message back EXACTLY as received — see file header.
    messages.push(message);
    for (const call of message.tool_calls) {
      const tool = toolsByName.get(call.function.name);
      const result = tool
        ? await runTool(tool, call)
        : { content: `error: unknown tool "${call.function.name}"`, record: { tool: call.function.name, args: call.function.arguments, ok: false, ms: 0 } };
      calls.push(result.record);
      messages.push({ role: "tool", tool_call_id: call.id, content: result.content });
    }
  }
}
