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

const { createSegmentAgent } = await import("./podcast-agent");
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
