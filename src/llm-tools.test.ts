/**
 * Hermetic tests for the generic tool-calling loop. No network: `fetchImpl`
 * is injected directly (see podcast-script.test.ts for the shared config
 * env baseline this file mirrors).
 */
import { describe, expect, test } from "bun:test";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";

const { runToolLoop } = await import("./llm-tools");
type ToolDef = import("./llm-tools").ToolDef;
type ToolLoopFetch = import("./llm-tools").ToolLoopFetch;

function rawRes(status: number, body: unknown): { status: number; body: string } {
  return { status, body: JSON.stringify(body) };
}

function chatResponse(message: Record<string, unknown>, usage = { prompt_tokens: 10, completion_tokens: 5 }): { status: number; body: string } {
  return rawRes(200, { choices: [{ message, finish_reason: message["tool_calls"] ? "tool_calls" : "stop" }], usage });
}

function scriptedFetch(responses: Array<{ status: number; body: string }>): { fetchImpl: ToolLoopFetch; calls: Array<{ url: string; body: unknown }> } {
  const calls: Array<{ url: string; body: unknown }> = [];
  let i = 0;
  const fetchImpl: ToolLoopFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: init.body ? JSON.parse(init.body as string) : undefined });
    const res = responses[i];
    i++;
    if (!res) throw new Error(`scriptedFetch: no response scripted for call ${i}`);
    return res;
  }) as ToolLoopFetch;
  return { fetchImpl, calls };
}

const noopTool: ToolDef = {
  name: "noop",
  description: "does nothing",
  parameters: { type: "object", properties: {} },
  execute: async () => "ok",
};

describe("runToolLoop", () => {
  test("returns final content when no tool call is made", async () => {
    const { fetchImpl } = scriptedFetch([chatResponse({ role: "assistant", content: "all done" })]);
    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });
    expect(result.content).toBe("all done");
    expect(result.calls).toEqual([]);
    expect(result.rounds).toBe(1);
  });

  test("echoes the assistant message verbatim, including provider-specific extra fields, and attaches tool results by tool_call_id in order", async () => {
    const assistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "toolA", arguments: JSON.stringify({ x: 1 }) } },
        { id: "call_2", type: "function", function: { name: "toolB", arguments: JSON.stringify({ y: 2 }) } },
      ],
      extra_content: { google: { thought_signature: "opaque-signature-blob" } },
    };
    const { fetchImpl, calls } = scriptedFetch([
      chatResponse(assistantMessage),
      chatResponse({ role: "assistant", content: "final answer" }),
    ]);

    const seen: string[] = [];
    const toolA: ToolDef = {
      name: "toolA",
      description: "a",
      parameters: {},
      execute: async (args) => {
        seen.push("toolA");
        expect(args).toEqual({ x: 1 });
        return "result-a";
      },
    };
    const toolB: ToolDef = {
      name: "toolB",
      description: "b",
      parameters: {},
      execute: async (args) => {
        seen.push("toolB");
        expect(args).toEqual({ y: 2 });
        return "result-b";
      },
    };

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [toolA, toolB],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("final answer");
    expect(seen).toEqual(["toolA", "toolB"]);
    expect(result.calls.map((c) => c.tool)).toEqual(["toolA", "toolB"]);
    expect(result.calls.every((c) => c.ok)).toBe(true);

    // Second request's messages must contain the assistant message UNCHANGED
    // (including extra_content) plus tool results keyed by tool_call_id, in order.
    const secondRequestBody = calls[1]?.body as { messages: Array<Record<string, unknown>> };
    const echoedAssistant = secondRequestBody.messages.find((m) => m["role"] === "assistant");
    expect(echoedAssistant).toEqual(assistantMessage);

    const toolMessages = secondRequestBody.messages.filter((m) => m["role"] === "tool");
    expect(toolMessages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "result-a" },
      { role: "tool", tool_call_id: "call_2", content: "result-b" },
    ]);
  });

  test("a throwing tool yields an error-string tool message and the loop continues", async () => {
    const assistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "boom", arguments: "{}" } }],
    };
    const { fetchImpl, calls } = scriptedFetch([
      chatResponse(assistantMessage),
      chatResponse({ role: "assistant", content: "recovered" }),
    ]);
    const boom: ToolDef = {
      name: "boom",
      description: "throws",
      parameters: {},
      execute: async () => {
        throw new Error("kaboom");
      },
    };

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [boom],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("recovered");
    expect(result.calls).toEqual([{ tool: "boom", args: {}, ok: false, ms: expect.any(Number) }]);

    const secondRequestBody = calls[1]?.body as { messages: Array<Record<string, unknown>> };
    const toolMessage = secondRequestBody.messages.find((m) => m["role"] === "tool");
    expect(toolMessage).toEqual({ role: "tool", tool_call_id: "call_1", content: "error: kaboom" });
  });

  test("an unparsable arguments string produces an error tool result without crashing the loop", async () => {
    const assistantMessage = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "noop", arguments: "{not json" } }],
    };
    const { fetchImpl } = scriptedFetch([chatResponse(assistantMessage), chatResponse({ role: "assistant", content: "done" })]);

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [noopTool],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("done");
    expect(result.calls[0]?.ok).toBe(false);
  });

  test("is not force-concluded after many rounds — it keeps going until the model stops calling tools", async () => {
    const alwaysWantsTool = () => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_x", type: "function", function: { name: "noop", arguments: "{}" } }],
    });
    const roundsWantingTools = 15; // well past the old 12-round cap
    const { fetchImpl, calls } = scriptedFetch([
      ...Array.from({ length: roundsWantingTools }, () => chatResponse(alwaysWantsTool())),
      chatResponse({ role: "assistant", content: "final after many rounds" }),
    ]);

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [noopTool],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("final after many rounds");
    expect(result.rounds).toBe(roundsWantingTools + 1);
    expect(calls).toHaveLength(roundsWantingTools + 1);
    // No forced "tool_choice: none" / "Conclude now" round is ever injected.
    for (const call of calls) {
      const body = call.body as { tool_choice?: string; messages: Array<Record<string, unknown>> };
      expect(body.tool_choice).toBeUndefined();
      expect(body.messages.some((m) => m["content"] === "Conclude now with your final answer.")).toBe(false);
    }
  });

  test("aborts when one round's model call produces nothing within the idle window", async () => {
    const neverResolves: ToolLoopFetch = (() => new Promise(() => {})) as ToolLoopFetch;

    await expect(
      runToolLoop({
        model: "test-model",
        systemPrompt: "sys",
        userContent: "user",
        tools: [],
        maxCompletionTokens: 100,
        stage: "test",
        usageEndpoint: "podcast-research",
        fetchImpl: neverResolves,
        roundIdleTimeoutMs: 20,
      }),
    ).rejects.toThrow(/round 1 produced no response/);
  });

  test("retries a terminal round with doubled budget when content is empty (finish_reason=length), then succeeds", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      rawRes(200, { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: { completion_tokens: 100 } }),
      chatResponse({ role: "assistant", content: "recovered after doubled budget" }),
    ]);

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("recovered after doubled budget");
    expect(calls).toHaveLength(2);
    const secondBody = calls[1]?.body as { max_completion_tokens: number };
    expect(secondBody.max_completion_tokens).toBe(200);
  });

  test("retries a round whose tool_calls arrived with finish_reason=length (possibly truncated arguments), then proceeds once the retry is complete", async () => {
    const truncatedToolCall = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "noop", arguments: "{}" } }],
    };
    const { fetchImpl, calls } = scriptedFetch([
      // Round 1, first attempt: tool_calls present but finish_reason=length — the
      // old behaviour returned this as-is (no retry) purely because tool_calls
      // were present, ignoring finish_reason entirely.
      rawRes(200, { choices: [{ message: truncatedToolCall, finish_reason: "length" }], usage: {} }),
      // Round 1, retry with doubled budget: same tool call, this time complete.
      chatResponse(truncatedToolCall),
      // Round 2: the model concludes.
      chatResponse({ role: "assistant", content: "final answer" }),
    ]);

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [noopTool],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(calls).toHaveLength(3);
    expect((calls[1]?.body as { max_completion_tokens: number }).max_completion_tokens).toBe(200);
    expect(result.content).toBe("final answer");
    expect(result.calls.map((c) => c.tool)).toEqual(["noop"]);
  });

  test("throws when the retry is still empty", async () => {
    const empty = rawRes(200, { choices: [{ message: { role: "assistant", content: "" }, finish_reason: "length" }], usage: {} });
    const { fetchImpl } = scriptedFetch([empty, empty]);

    await expect(
      runToolLoop({
        model: "test-model",
        systemPrompt: "sys",
        userContent: "user",
        tools: [],
        maxCompletionTokens: 100,
        stage: "test",
        usageEndpoint: "podcast-research",
        fetchImpl,
      }),
    ).rejects.toThrow(/returned empty content.*after retry with doubled budget/);
  });

  test("passes reasoning_effort through to the request body when set", async () => {
    const { fetchImpl, calls } = scriptedFetch([chatResponse({ role: "assistant", content: "done" })]);
    await runToolLoop({
      model: "deepseek-v4.1-flash",
      systemPrompt: "sys",
      userContent: "user",
      tools: [],
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      reasoningEffort: "high",
      fetchImpl,
    });
    const body = calls[0]?.body as { reasoning_effort?: string };
    expect(body.reasoning_effort).toBe("high");
  });

  test("throws on a non-2xx response", async () => {
    const { fetchImpl } = scriptedFetch([rawRes(500, { error: "boom" })]);
    await expect(
      runToolLoop({
        model: "test-model",
        systemPrompt: "sys",
        userContent: "user",
        tools: [],
        maxCompletionTokens: 100,
        stage: "test",
        usageEndpoint: "podcast-research",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  describe("/v1/responses transport (gpt-6.1)", () => {
    // Replies recorded from IU 2026-10-26.
    const callReply = rawRes(200, {
      status: "completed",
      output: [{ id: "fc_1", type: "function_call", status: "completed", arguments: '{"a":2,"b":3}', call_id: "call_1", name: "add" }],
      usage: { input_tokens: 63, input_tokens_details: { cached_tokens: 0 }, output_tokens: 21 },
    });
    const finalReply = rawRes(200, {
      status: "completed",
      output: [{ id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "2 + 3 = 5." }] }],
      usage: { input_tokens: 95, input_tokens_details: { cached_tokens: 40 }, output_tokens: 12 },
    });
    const addTool: ToolDef = { name: "add", description: "add", parameters: { type: "object", properties: {} }, execute: async (a) => String((a as { a: number; b: number }).a + (a as { a: number; b: number }).b) };

    test("posts flat tools to /responses, echoes output items and answers with function_call_output", async () => {
      const { fetchImpl, calls } = scriptedFetch([callReply, finalReply]);
      const result = await runToolLoop({ model: "gpt-6.1-sol", systemPrompt: "sys", userContent: "2+3?", tools: [addTool], maxCompletionTokens: 500, stage: "test", usageEndpoint: "podcast-research", reasoningEffort: "high", fetchImpl });
      expect(result.content).toBe("2 + 3 = 5.");
      expect(result.rounds).toBe(2);
      expect(result.calls).toMatchObject([{ tool: "add", ok: true }]);
      expect(calls[0]!.url).toEndWith("/responses");
      const first = calls[0]!.body as Record<string, unknown>;
      expect(first["instructions"]).toBe("sys");
      expect(first["max_output_tokens"]).toBe(500);
      expect(first["reasoning"]).toEqual({ effort: "high" });
      expect(first["tools"]).toEqual([{ type: "function", name: "add", description: "add", parameters: { type: "object", properties: {} } }]);
      expect(first["input"]).toEqual([{ role: "user", content: "2+3?" }]);
      const second = (calls[1]!.body as { input: unknown[] }).input;
      expect(second[1]).toMatchObject({ type: "function_call", call_id: "call_1" });
      expect(second[2]).toEqual({ type: "function_call_output", call_id: "call_1", output: "5" });
    });

    test("an incomplete reply cut at max_output_tokens retries with a doubled budget", async () => {
      const cut = rawRes(200, { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 5, output_tokens: 500 } });
      const { fetchImpl, calls } = scriptedFetch([cut, finalReply]);
      const result = await runToolLoop({ model: "gpt-6.1-sol", systemPrompt: "s", userContent: "u", tools: [], maxCompletionTokens: 500, stage: "test", usageEndpoint: "podcast-research", fetchImpl });
      expect(result.content).toBe("2 + 3 = 5.");
      expect((calls[1]!.body as Record<string, unknown>)["max_output_tokens"]).toBe(1000);
    });
  });
});
