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
  /** Rounds that may contain tool calls; after that one final call runs with `tool_choice: "none"`. */
  maxRounds: number;
  maxCompletionTokens: number;
  /** Span attribute `audio.podcast.stage` (e.g. "research"). */
  stage: string;
  /** Usage row endpoint (e.g. "podcast-research"). */
  usageEndpoint: string;
  /** Default `rawFetch` (tests inject a fake with the same `(url, init) => Promise<RawResponse>` shape). */
  fetchImpl?: ToolLoopFetch;
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
  toolChoiceNone?: boolean;
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
      if (params.toolChoiceNone) body["tool_choice"] = "none";

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
 * Run a full tool-calling round trip: system + user message, then rounds of
 * assistant tool calls executed sequentially, until the model answers with no
 * tool call or `maxRounds` is exhausted (in which case one final call forces
 * `tool_choice: "none"`).
 */
export async function runToolLoop(params: ToolLoopParams): Promise<ToolLoopResult> {
  const fetchImpl = params.fetchImpl ?? rawFetch;
  const toolsByName = new Map(params.tools.map((t) => [t.name, t] as const));
  const messages: ChatMessage[] = [
    { role: "system", content: params.systemPrompt },
    { role: "user", content: params.userContent },
  ];
  const calls: ToolCallRecord[] = [];

  for (let round = 1; round <= params.maxRounds; round++) {
    const { message } = await callChat({
      model: params.model,
      messages,
      tools: params.tools,
      maxCompletionTokens: params.maxCompletionTokens,
      stage: params.stage,
      round,
      usageEndpoint: params.usageEndpoint,
      fetchImpl,
    });

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

  // Round cap exhausted and the model still wants tools: force a final answer.
  messages.push({ role: "user", content: "Conclude now with your final answer." });
  const { message } = await callChat({
    model: params.model,
    messages,
    tools: params.tools,
    toolChoiceNone: true,
    maxCompletionTokens: params.maxCompletionTokens,
    stage: params.stage,
    round: params.maxRounds + 1,
    usageEndpoint: params.usageEndpoint,
    fetchImpl,
  });
  return { content: message.content ?? "", calls, rounds: params.maxRounds + 1 };
}
