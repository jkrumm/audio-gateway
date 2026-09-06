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
      maxRounds: 3,
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
      maxRounds: 5,
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
      maxRounds: 5,
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
      maxRounds: 5,
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("done");
    expect(result.calls[0]?.ok).toBe(false);
  });

  test("hitting the round cap forces a final tool_choice: none call", async () => {
    const alwaysWantsTool = () => ({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_x", type: "function", function: { name: "noop", arguments: "{}" } }],
    });
    const { fetchImpl, calls } = scriptedFetch([
      chatResponse(alwaysWantsTool()),
      chatResponse(alwaysWantsTool()),
      chatResponse({ role: "assistant", content: "final under cap" }),
    ]);

    const result = await runToolLoop({
      model: "test-model",
      systemPrompt: "sys",
      userContent: "user",
      tools: [noopTool],
      maxRounds: 2,
      maxCompletionTokens: 100,
      stage: "test",
      usageEndpoint: "podcast-research",
      fetchImpl,
    });

    expect(result.content).toBe("final under cap");
    expect(result.rounds).toBe(3);
    expect(calls).toHaveLength(3);
    const finalRequestBody = calls[2]?.body as { tool_choice?: string; messages: Array<Record<string, unknown>> };
    expect(finalRequestBody.tool_choice).toBe("none");
    expect(finalRequestBody.messages.at(-1)).toEqual({ role: "user", content: "Conclude now with your final answer." });
  });

  test("throws on a non-2xx response", async () => {
    const { fetchImpl } = scriptedFetch([rawRes(500, { error: "boom" })]);
    await expect(
      runToolLoop({
        model: "test-model",
        systemPrompt: "sys",
        userContent: "user",
        tools: [],
        maxRounds: 3,
        maxCompletionTokens: 100,
        stage: "test",
        usageEndpoint: "podcast-research",
        fetchImpl,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });
});
