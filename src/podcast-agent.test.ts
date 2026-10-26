/**
 * Hermetic tests for the agentic segment writer: scripted tool-call replies drive `createSegmentAgent`
 * through lint → fix → submit, the rejection/acceptance rules and the no-submit fallback.
 */
import { describe, expect, test } from "bun:test";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";

const { createSegmentAgent, agentReasoningEffort } = await import("./podcast-agent");
const { EMPTY_DOSSIER } = await import("./podcast-types");
type ToolLoopFetch = import("./llm-tools").ToolLoopFetch;
type AgentRun = import("./podcast-agent").AgentRun;

const HOSTS: [import("./podcast-script").PodcastHost, import("./podcast-script").PodcastHost] = [
  { id: "A", name: "Jonas", voice: "Charon" },
  { id: "B", name: "Lena", voice: "Erinome" },
];
const REQ: import("./podcast-script").PodcastScriptRequest = {
  source: "Der Dienst heißt Warden und läuft auf dem Mini.",
  language: "de",
  minutes: 10,
  hosts: HOSTS,
  series: "Test",
  dossier: { ...EMPTY_DOSSIER, glossary: [{ term: "Warden", plain: "ein Dienst, der Arbeitszustand hält" }] },
  episodeBrief: { format: "Gespräch", rationale: "r", roles: { A: "erklärt", B: "fragt" }, tone: "ruhig", humor: "none", opening: "direkt", closing: "offen", rhythm: "gemischt", minutes: 10, segments: 1, devices: [], avoid: [], glossaryPolicy: "" },
};
const SPEC = { title: "Seg", goal: "g", keyFacts: ["Warden läuft auf dem Mini."], targetWords: 30, tension: "t" };
const OUTLINE: import("./podcast-script").Outline = { title: "T", description: "d", coverPrompt: "c", genres: [], motif: "", throughLine: "", hook: "", reveals: [], digressions: [], segments: [SPEC] };

const words = (n: number, prefix: string): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const CLEAN = [
  { speaker: "A", text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. ${words(8, "alpha")}` },
  { speaker: "B", text: "Und wo läuft er?" },
  { speaker: "A", text: `Auf dem Mini. ${words(6, "beta")}` },
];

function toolCall(name: string, args: unknown, id = `c-${name}`): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
  };
}
const plainReply = (content: string): { status: number; body: string } => ({
  status: 200,
  body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
});

function scripted(replies: Array<{ status: number; body: string }>): { fetchImpl: ToolLoopFetch; bodies: Array<{ messages: Array<{ role: string; content?: string }> }> } {
  const bodies: Array<{ messages: Array<{ role: string; content?: string }> }> = [];
  let i = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    const reply = replies[i++];
    if (!reply) throw new Error(`no scripted reply for round ${i}`);
    return reply;
  }) as ToolLoopFetch;
  return { fetchImpl, bodies };
}

const draft = (fetchImpl: ToolLoopFetch, onRun?: (run: AgentRun) => void) =>
  createSegmentAgent({ model: "writer", maxUnitChars: 3000, fetchImpl, onRun }).draft({ req: REQ, outline: OUTLINE, index: 0, total: 1, showBible: "", voice: "" });

describe("agentReasoningEffort", () => {
  test("Claude gets high, gpt-6 none (tools reject any other effort), deepseek its family value", () => {
    expect(agentReasoningEffort("claude-opus-5-5")).toBe("high");
    expect(agentReasoningEffort("gpt-6.1-sol")).toBe("none");
    expect(agentReasoningEffort("gpt-6-luna")).toBe("none");
    expect(agentReasoningEffort("deepseek-v4.1-flash")).toBe("high");
  });
});

describe("segment agent", () => {
  test("measures with lint_segment, fixes, and ends the loop on an accepted submit", async () => {
    const runs: AgentRun[] = [];
    const { fetchImpl, bodies } = scripted([
      toolCall("lint_segment", { turns: [{ speaker: "A", text: "Nicht zuletzt zählt der Preis." }] }),
      toolCall("submit_segment", { turns: CLEAN }),
    ]);
    const turns = await draft(fetchImpl, (r) => runs.push(r));
    expect(turns.map((t) => t.speaker)).toEqual(["A", "B", "A"]);
    expect(bodies).toHaveLength(2); // no closing round after ACCEPTED
    const lintResult = bodies[1]!.messages.find((m) => m.role === "tool")?.content ?? "";
    expect(lintResult).toContain("METRICS:");
    expect(lintResult).toContain("Stock phrase");
    expect(runs[0]).toMatchObject({ mode: "draft", rejections: 0, fellBack: false });
  });

  test("a blocking finding is rejected on submit until fixed", async () => {
    const bad = [{ speaker: "A", text: `Nicht zuletzt zählt der Preis. ${words(10, "gamma")}` }, ...CLEAN.slice(1)];
    const runs: AgentRun[] = [];
    const { fetchImpl, bodies } = scripted([toolCall("submit_segment", { turns: bad }), toolCall("submit_segment", { turns: CLEAN })]);
    await draft(fetchImpl, (r) => runs.push(r));
    expect(bodies[1]!.messages.find((m) => m.role === "tool")?.content).toContain("REJECTED — blocking");
    expect(runs[0]).toMatchObject({ submits: 2, rejections: 1 });
  });

  test("advisory findings are rejected once; accepting them with a reason lets the submit through", async () => {
    // no question anywhere in a long-enough segment would be advisory only after 8 turns; use an over-short segment instead
    const short = [{ speaker: "A", text: `Warden ist ein Dienst, der den Arbeitszustand hält und auf dem Mini läuft. ${words(4, "kurz")}` }];
    const runs: AgentRun[] = [];
    const { fetchImpl, bodies } = scripted([
      toolCall("submit_segment", { turns: short }),
      toolCall("submit_segment", { turns: short, acceptAdvisory: [{ rule: "length-under", reason: "alle Kernfakten stehen drin, mehr wäre Füllstoff" }] }),
    ]);
    const turns = await draft(fetchImpl, (r) => runs.push(r));
    expect(turns).toHaveLength(1);
    expect(bodies[1]!.messages.find((m) => m.role === "tool")?.content).toContain("REJECTED once");
    expect(runs[0]!.accepted).toEqual([{ rule: "length-under", reason: "alle Kernfakten stehen drin, mehr wäre Füllstoff" }]);
  });

  test("a model that stops without submitting falls back to its last measured draft", async () => {
    const runs: AgentRun[] = [];
    const { fetchImpl } = scripted([toolCall("lint_segment", { turns: CLEAN }), plainReply("Fertig.")]);
    const turns = await draft(fetchImpl, (r) => runs.push(r));
    expect(turns).toHaveLength(3);
    expect(runs[0]).toMatchObject({ fellBack: true, submits: 0 });
  });

  test("a tag the sanitizer would silently strip is still a blocking finding on submit", async () => {
    const withInvented = [{ speaker: "A", text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. <sniff> ${words(8, "alpha")}` }, ...CLEAN.slice(1)];
    const { fetchImpl, bodies } = scripted([toolCall("submit_segment", { turns: withInvented }), toolCall("submit_segment", { turns: CLEAN })]);
    await draft(fetchImpl);
    expect(bodies[1]!.messages.find((m) => m.role === "tool")?.content).toContain("not in the allowed list");
    const leading = [{ speaker: "A", text: "<laugh> Ja." }, ...CLEAN.slice(1)];
    const second = scripted([toolCall("submit_segment", { turns: leading }), toolCall("submit_segment", { turns: CLEAN })]);
    await draft(second.fetchImpl);
    expect(second.bodies[1]!.messages.find((m) => m.role === "tool")?.content).toContain("first word of a short line");
  });

  test("a loop that ends on a draft the gate rejects throws, so the caller falls back to the single-shot writer", async () => {
    const bad = [{ speaker: "A", text: `Nicht zuletzt zählt der Preis. ${words(10, "gamma")}` }, ...CLEAN.slice(1)];
    const runs: AgentRun[] = [];
    const { fetchImpl } = scripted([toolCall("lint_segment", { turns: bad }), plainReply("Fertig.")]);
    await expect(draft(fetchImpl, (r) => runs.push(r))).rejects.toThrow(/blocking finding/);
    expect(runs[0]).toMatchObject({ fellBack: true });
  });

  test("brain tools and the brain instruction exist only when a brain is configured; over-length blocks, under-length does not", async () => {
    const without = scripted([toolCall("submit_segment", { turns: CLEAN })]);
    await draft(without.fetchImpl);
    expect(without.bodies[0]!.messages[0]!.content).not.toContain("brain_search");
    const long = [{ speaker: "A", text: `Der Dienst heißt Warden, er ist ein Dienst, der den Arbeitszustand hält. ${words(80, "lang")}` }, { speaker: "B", text: "Und wo läuft er?" }];
    const over = scripted([toolCall("submit_segment", { turns: long }), toolCall("submit_segment", { turns: CLEAN })]);
    await draft(over.fetchImpl);
    expect(over.bodies[1]!.messages.find((m) => m.role === "tool")?.content).toContain("LENGTH:");
  });

  test("a revision runs the same loop with the notes in its prompt", async () => {
    const { fetchImpl, bodies } = scripted([toolCall("submit_segment", { turns: CLEAN })]);
    const turns = await createSegmentAgent({ model: "writer", maxUnitChars: 3000, fetchImpl }).revise({
      req: REQ,
      outline: OUTLINE,
      segments: [{ title: "Seg", turns: CLEAN as import("./podcast-script").ScriptTurn[] }],
      index: 0,
      total: 1,
      notes: [{ segmentIndex: 0, turnIndex: null, reviewer: "dramaturge@m", note: "Mehr Humor an der richtigen Stelle." }],
      showBible: "",
      voice: "",
    });
    expect(turns).toHaveLength(3);
    expect(bodies[0]!.messages[1]!.content).toContain("Mehr Humor an der richtigen Stelle.");
    expect(bodies[0]!.messages[0]!.content).toContain("REVISING ONE SEGMENT");
  });

  test("gpt-6.1 has no function tools on chat/completions: the agent throws before any request", async () => {
    const { fetchImpl, bodies } = scripted([]);
    await expect(createSegmentAgent({ model: "gpt-6.1-sol", maxUnitChars: 3000, fetchImpl }).draft({ req: REQ, outline: OUTLINE, index: 0, total: 1, showBible: "", voice: "" })).rejects.toThrow(/\/v1\/responses/);
    expect(bodies).toHaveLength(0);
  });

  test("a model that never measured anything throws, so the caller can fall back to the single-shot writer", async () => {
    const { fetchImpl } = scripted([plainReply("Hier ist kein Tool-Aufruf.")]);
    await expect(draft(fetchImpl)).rejects.toThrow(/without a measured draft/);
  });

  test("glossary_lookup answers from the dossier; the system prompt carries the tool workflow", async () => {
    const { fetchImpl, bodies } = scripted([toolCall("glossary_lookup", { term: "warden" }), toolCall("submit_segment", { turns: CLEAN })]);
    await draft(fetchImpl);
    expect(bodies[1]!.messages.find((m) => m.role === "tool")?.content).toContain("ein Dienst, der Arbeitszustand hält");
    expect(bodies[0]!.messages[0]!.content).toContain("submit_segment is the only way to finish");
  });
});
