/**
 * Wave 5 — episode structure: listener asks get a verdict, the opening frames the question, the length is held.
 * Fixtures are the two real jobs of one topic: v1 (503c28f0, old pipeline) answered the raw-carrot question; v2 (b78cb035)
 * turned the carrot segment into carrot greens and never answered it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";

const { askCoverage, assignAsks } = await import("./podcast-asks");
const { lintNotes, lintSegments } = await import("./podcast-lint");
const script = await import("./podcast-script");
type ScriptSegment = import("./podcast-script").ScriptSegment;

const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(import.meta.dir, "__fixtures__", name), "utf8")) as T;
const V1 = fixture<{ segments: ScriptSegment[] }>("episode-503c28f0.script.json");
const V2 = fixture<{ segments: ScriptSegment[] }>("episode-b78cb035.script.json");

const brief0 = fixture<Record<string, unknown>>("episode-b78cb035.brief.json");
const RAW_CARROT = "Karotten roh, ungewaschen und ungeschält direkt aus der Tüte essen — ist das okay?";
const KIWI = "Kiwi mit Schale essen?";

describe("askCoverage / assignAsks", () => {
  test("coverage is the share of the ask's distinctive words that appear", () => {
    expect(askCoverage(RAW_CARROT, "Rohe Karotten aus der Tüte, ungewaschen: das ist okay, du isst sie ungeschält")).toBeGreaterThan(0.5);
    expect(askCoverage(RAW_CARROT, "Das Grün der Möhre eignet sich für Pesto")).toBeLessThan(0.2);
    expect(askCoverage("", "irgendwas")).toBe(1);
  });

  test("the outline's own assignment wins (a paraphrase counts), unnamed asks go to the best textual fit", () => {
    const segments = [
      { title: "Karotte: Wurzel", goal: "Rohe Karotten, Wasch- und Schälbefund", keyFacts: ["41 Proben"], answers: [] as string[] },
      { title: "Kiwi", goal: "Schale, Rückstände", keyFacts: [], answers: [] as string[] },
      { title: "Hokkaido", goal: "Waschen", keyFacts: [], answers: ["Kiwi mit Schale essen"] },
    ];
    const out = assignAsks(segments, [RAW_CARROT, KIWI]);
    expect(out.map((s) => s.answers)).toEqual([[RAW_CARROT], [], [KIWI]]);
    expect(assignAsks(segments, []).every((s) => s.answers!.length === 0)).toBe(true);
  });
});

describe("assignAsks — regressions from review", () => {
  test("two asks that share most words stay with the segment that named them (best match, not first match)", () => {
    const peel = "Soll ich Karotten schälen?";
    const wash = "Soll ich Karotten waschen?";
    const segments = [
      { title: "a", goal: "", keyFacts: [], answers: [peel] },
      { title: "b", goal: "", keyFacts: [], answers: [wash] },
    ];
    expect(assignAsks(segments, [peel, wash]).map((s) => s.answers)).toEqual([[peel], [wash]]);
  });

  test("an ask nobody names goes to the best textual fit; all-zero overlap falls to segment 0; no segments drops nothing silently", () => {
    const none: string[] = [];
    const out = assignAsks([{ title: "x", goal: "y", keyFacts: none, answers: none }, { title: "z", goal: "w", keyFacts: none, answers: none }], ["Etwas völlig anderes?"]);
    expect(out.map((s) => s.answers)).toEqual([["Etwas völlig anderes?"], []]);
    expect(assignAsks([], ["Frage?"])).toEqual([]);
  });
});

describe("ask lint on the real fixtures", () => {
  test("v2 never answers the raw-carrot ask in its carrot segment; v1 does in its washing segment", () => {
    const v2 = lintSegments(V2.segments, { asks: [{ ask: RAW_CARROT, segmentIndex: 0 }] });
    expect(v2.findings.filter((f) => f.rule === "ask-uncovered")).toHaveLength(1);
    const v1 = lintSegments(V1.segments, { asks: [{ ask: RAW_CARROT, segmentIndex: 2 }] });
    expect(v1.findings.filter((f) => f.rule === "ask-uncovered")).toHaveLength(0);
  });

  test("v2 opens cold on 'Das Grün.'; v1 opens on the question's two limits", () => {
    const v2 = lintSegments(V2.segments, { openingFrame: [RAW_CARROT] });
    expect(v2.findings.map((f) => f.rule)).toContain("opening-unframed");
    const v1 = lintSegments(V1.segments, { openingFrame: ["Zwei Grenzen: ab wann Ware nicht mehr verkauft werden darf und ab wann sie die Gesundheit gefährdet"] });
    expect(v1.findings.map((f) => f.rule)).not.toContain("opening-unframed");
  });

  test("no asks and no frame configured → no ask findings at all (older episodes lint as before)", () => {
    expect(lintSegments(V2.segments, {}).findings.filter((f) => f.rule === "ask-uncovered" || f.rule === "opening-unframed")).toEqual([]);
  });

  test("an ask whose segment is missing from the script is a finding, not a silent pass", () => {
    const report = lintSegments(V2.segments, { asks: [{ ask: RAW_CARROT, segmentIndex: 9 }] });
    expect(report.findings.map((f) => f.rule)).toContain("ask-uncovered");
  });

  test("openingFrameOf is empty when the brief has no asks, even with a through-line", () => {
    const noAsks = { ...brief0, asks: [] } as unknown as import("./podcast-types").EpisodeBrief;
    const outline = { throughLine: "Was ist mit der Schale?" } as unknown as import("./podcast-script").Outline;
    expect(script.openingFrameOf(noAsks, outline)).toEqual([]);
    expect(script.openingFrameOf({ ...noAsks, asks: [RAW_CARROT] }, outline)).toEqual([RAW_CARROT, "Was ist mit der Schale?"]);
  });

  test("both findings are sent to the writer as revision notes", () => {
    const report = lintSegments(V2.segments, { asks: [{ ask: RAW_CARROT, segmentIndex: 0 }], openingFrame: [RAW_CARROT] });
    const rules = lintNotes(report).map((n) => n.note);
    expect(rules.some((n) => n.includes("gives a verdict"))).toBe(true);
    expect(rules.some((n) => n.includes("never say what this episode answers"))).toBe(true);
  });
});

describe("outline and prompts", () => {
  const brief = { ...fixture<Record<string, unknown>>("episode-b78cb035.brief.json"), asks: [RAW_CARROT, KIWI] } as unknown as import("./podcast-types").EpisodeBrief;

  test("parseOutline reads `answers`; withAssignedAsks guarantees every ask a segment", () => {
    const outline = script.parseOutline(
      JSON.stringify({ title: "T", segments: [{ title: "Karotte roh", goal: "Rohe Karotten ungewaschen", key_facts: [], target_words: 400, tension: "", answers: [RAW_CARROT] }, { title: "Kiwi-Schale", goal: "Schale", key_facts: [], target_words: 300, tension: "" }] }),
    );
    expect(outline.segments[0]!.answers).toEqual([RAW_CARROT]);
    const assigned = script.withAssignedAsks(outline, [RAW_CARROT, KIWI]);
    expect(assigned.segments.flatMap((s) => s.answers ?? [])).toEqual([RAW_CARROT, KIWI]);
    expect(script.outlineAsks(assigned)).toEqual([{ ask: RAW_CARROT, segmentIndex: 0 }, { ask: KIWI, segmentIndex: 1 }]);
  });

  test("segment prompt: the owning segment lists its asks; the first segment frames the question", () => {
    const req = { episodeBrief: brief, hosts: [{ id: "A", name: "Jonas", voice: "x", speed: 1 }, { id: "B", name: "Lena", voice: "y", speed: 1 }], language: "de" } as unknown as import("./podcast-script").PodcastScriptRequest;
    const seg = { title: "Karotte", goal: "g", keyFacts: ["f"], targetWords: 300, tension: "t", answers: [RAW_CARROT] };
    const outline = { title: "T", description: "", coverPrompt: "", genres: [], motif: "", throughLine: "", hook: "", reveals: [], digressions: [], segments: [seg, { ...seg, answers: [] }] };
    const first = script.segmentPrompt({ req, outline, segment: seg, index: 0, total: 2, showBible: "" });
    expect(first).toContain("The listener ASKED these");
    expect(first).toContain(RAW_CARROT);
    expect(first).toContain("Within the first 3 turns the hosts say plainly what this episode answers");
    const second = script.segmentPrompt({ req, outline, segment: outline.segments[1]!, index: 1, total: 2, previous: seg, showBible: "" });
    expect(second).not.toContain("The listener ASKED these");
  });

  test("outline prompt carries the asks and the 'answers' field; the dramaturge checks verdicts", () => {
    const req = { episodeBrief: brief, hosts: [{ id: "A", name: "Jonas", voice: "x", speed: 1 }, { id: "B", name: "Lena", voice: "y", speed: 1 }], language: "de", source: "s", dossier: { glossary: [], additions: [], toolCalls: [] } } as unknown as import("./podcast-script").PodcastScriptRequest;
    const prompt = script.outlinePrompt(req, 4, 1500, "");
    expect(prompt).toContain("LISTENER ASKS");
    expect(prompt).toContain(RAW_CARROT);
    expect(prompt).toContain('"answers"');
  });
});

describe("length in the profile", () => {
  const dossier = { glossary: [], additions: [], toolCalls: [] } as unknown as import("./podcast-types").Dossier;
  const brief = { ...fixture<Record<string, unknown>>("episode-b78cb035.brief.json"), asks: [RAW_CARROT] } as unknown as import("./podcast-types").EpisodeBrief;
  const toScript = (segments: ScriptSegment[], extra: object = {}) => ({ title: "t", description: "", coverPrompt: "", genres: [], language: "de" as const, segments, wordCount: 0, topics: [], ...extra });

  test("v2 (1,517 words for a 15-minute ask) is flagged short; v1 (2,368) is not", () => {
    const p2 = script.buildEpisodeProfile({ brief, script: toScript(V2.segments), dossier, requestedMinutes: 15 });
    expect(p2.lengthShort).toBe(true);
    expect(p2.lengthVsRequested).toBeLessThan(0.8);
    const p1 = script.buildEpisodeProfile({ brief, script: toScript(V1.segments), dossier, requestedMinutes: 15 });
    expect(p1.lengthShort).toBe(false);
    expect(p1.requestedMinutes).toBe(15);
  });

  test("the profile counts uncovered asks and whether the opening framed the question", () => {
    const p = script.buildEpisodeProfile({ brief, script: toScript(V2.segments, { asks: [{ ask: RAW_CARROT, segmentIndex: 0 }] }), dossier, requestedMinutes: 15 });
    expect(p.asks).toEqual({ total: 1, uncovered: 1, openingFramed: false });
  });

  test("a script without ask assignments is reported unchecked, not clean", () => {
    const p = script.buildEpisodeProfile({ brief, script: toScript(V2.segments), dossier, requestedMinutes: 15 });
    expect(p.asks).toEqual({ total: 1, uncovered: null, openingFramed: null });
  });

  test("no requested minutes and no asks → neither field is invented", () => {
    const p = script.buildEpisodeProfile({ brief: { ...brief, asks: [] }, script: toScript(V1.segments), dossier });
    expect(p.lengthShort).toBeUndefined();
    expect(p.asks).toBeUndefined();
  });
});
