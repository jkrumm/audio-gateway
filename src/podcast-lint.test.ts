import { describe, expect, test } from "bun:test";
import { expressionSummary, lintNotes, lintSegmentation, lintSegments, renderLintReport } from "./podcast-lint";
import type { ScriptSegment } from "./podcast-script";

const seg = (turns: Array<["A" | "B", string]>): ScriptSegment => ({ title: "t", turns: turns.map(([speaker, text]) => ({ speaker, text })) });
const rules = (segments: ScriptSegment[], opts = {}): string[] => lintSegments(segments, opts).findings.map((f) => f.rule);

describe("lintSegments", () => {
  test("flags a turn that opens by repeating the previous turn", () => {
    const s = seg([
      ["A", "Um die zu übernehmen, brauchte es einen Sweeper von gut zweitausend Zeilen."],
      ["B", "Zweitausend Zeilen. Und trotzdem ist DBOS bei ihnen noch drin."],
    ]);
    expect(rules([s])).toContain("echo-reaction");
  });

  test("does not flag a short reaction that adds a new word", () => {
    const s = seg([
      ["A", "Der Sweeper ist gut zweitausend Zeilen lang."],
      ["B", "Wer pflegt den eigentlich?"],
    ]);
    expect(rules([s])).not.toContain("echo-reaction");
  });

  test("flags a lecture turn over the monologue limit", () => {
    const long = Array.from({ length: 140 }, (_, i) => `wort${i}`).join(" ");
    expect(rules([seg([["A", long], ["B", "Ok?"]])])).toContain("monologue");
  });

  test("flags stock phrases, and a second 'Stell dir vor'", () => {
    const s = seg([
      ["A", "Nicht zuletzt zählt der Preis."],
      ["B", "Stell dir vor, es läuft."],
      ["A", "Stell dir vor, es bricht."],
    ]);
    const found = lintSegments([s]).findings.filter((f) => f.rule === "stock-phrase");
    expect(found.map((f) => f.turnIndex)).toEqual([0, 2]);
  });

  test("flags a long segment where nobody asks anything, and metronomic turn lengths", () => {
    const turns: Array<["A" | "B", string]> = Array.from({ length: 10 }, (_, i) => [i % 2 === 0 ? "A" : "B", "Das ist ein Satz mit genau acht Wörtern drin."]);
    const found = rules([seg(turns)]);
    expect(found).toContain("no-questions");
    expect(found).toContain("uniform-turns");
  });

  test("a segment with questions and varied turns raises neither", () => {
    const turns: Array<["A" | "B", string]> = [
      ["A", "Kurz die Lage: drei Dienste, ein Vertrag, und der läuft Ende des Monats aus, weshalb wir heute entscheiden müssen."],
      ["B", "Und wer bezahlt das?"],
      ["A", "Du."],
      ["B", "Okay, und wenn wir wechseln, was bricht dann zuerst, die Anbindung oder die Abrechnung?"],
      ["A", "Die Abrechnung."],
      ["B", "Warum?"],
      ["A", "Weil sie als Einziges ohne Test läuft, und genau da ist die Lücke, die wir kennen."],
      ["B", "Gut."],
    ];
    const found = rules([seg(turns)]);
    expect(found).not.toContain("no-questions");
    expect(found).not.toContain("uniform-turns");
  });

  test("an acronym used without an introducing clause is flagged once; an introduced one is not", () => {
    const bare = seg([["A", "ADR einhundertneunzehn sagt etwas anderes."], ["B", "Und ADR einhundertvier?"]]);
    const found = lintSegments([bare]).findings.filter((f) => f.rule === "unintroduced-term");
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("ADR");

    const introduced = seg([["A", "Dazu gibt es Architecture Decision Records, kurz ADR. ADR einhundertneunzehn sagt etwas anderes."]]);
    expect(rules([introduced])).not.toContain("unintroduced-term");
  });

  test("glossary terms count as terms to introduce, host names do not", () => {
    const s = seg([["A", "Jonas und Lena fragen: Das Sweeper-Problem ist alt."]]);
    expect(rules([s], { glossaryTerms: ["Sweeper-Problem"], hostNames: ["Jonas", "Lena"] })).toContain("unintroduced-term");
    expect(rules([s], { hostNames: ["Jonas", "Lena"] })).not.toContain("unintroduced-term");
  });

  test("single CAPS emphasis words are not acronyms when the source does not spell them in caps", () => {
    const s = seg([["A", "Das ist KEIN Run, sondern ein Zustand, und DBOS merkt sich ihn."]]);
    const found = lintSegments([s], { source: "Wir nutzen DBOS für Workflows." }).findings.filter((f) => f.rule === "unintroduced-term");
    expect(found.map((f) => f.message.match(/"([^"]+)"/)?.[1])).toEqual(["DBOS"]);
  });

  test("speech tags are ignored by every rule", () => {
    const s = seg([["A", "Dazu gibt es Records, <short pause> kurz ADR."]]);
    expect(rules([s])).toEqual([]);
  });
});

describe("report rendering and notes", () => {
  test("only stock phrases and unintroduced terms become writer notes", () => {
    const report = lintSegments([seg([["A", "Nicht zuletzt zählt ADR."], ["B", "ADR."]])]);
    const notes = lintNotes(report);
    expect(notes.every((n) => n.reviewer === "lint" && n.segmentIndex === 0)).toBe(true);
    expect(notes.length).toBeGreaterThan(0);
    expect(renderLintReport(report)).toContain("words/turn");
  });
});

const words = (n: number, prefix = "wort"): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(" ");
const dseg = (turns: Array<["A" | "B", string, string?]>): ScriptSegment => ({
  title: "t",
  turns: turns.map(([speaker, text, delivery]) => ({ speaker, text, ...(delivery && { delivery }) })),
});

describe("expression lint", () => {
  test("flags a tag outside the allowlist", () => {
    expect(rules([dseg([["A", `${words(14)} <sniff> ${words(5)}`]])])).toContain("tag-not-allowed");
    expect(rules([dseg([["A", `${words(14)} <short pause> ${words(5)}`]])])).not.toContain("tag-not-allowed");
  });

  test("flags a tag as the first word of a short turn, not of a long one", () => {
    expect(rules([dseg([["A", `<laugh> ${words(4)}`]])])).toContain("tag-leads-short-turn");
    expect(rules([dseg([["A", `<laugh> ${words(20)}`]])])).not.toContain("tag-leads-short-turn");
  });

  test("flags adjacent tags", () => {
    expect(rules([dseg([["A", `${words(14)} <short pause> <laugh> ${words(5)}`]])])).toContain("tags-adjacent");
  });

  test("measures tags per ten turns against the band, only on segments long enough", () => {
    const plain = (n: number): Array<["A" | "B", string]> => Array.from({ length: n }, (_, i) => [i % 2 ? "B" : "A", `${words(10 + (i % 5) * 7, `w${i}x`)}?`]);
    expect(rules([dseg(plain(12))])).toContain("tags-below-band");
    expect(rules([dseg(plain(8))])).not.toContain("tags-below-band");
    const tagged = plain(12).map(([s, t]): ["A" | "B", string] => [s, `${t} <short pause> ${words(4, "z")} <short pause> ${words(3, "q")}`]);
    expect(rules([dseg(tagged)])).toContain("tags-above-band");
    const balanced = plain(12).map(([s, t], i): ["A" | "B", string] => [s, i % 4 === 0 ? `${t} <short pause> ${words(12, "y")}` : t]);
    const found = rules([dseg(balanced)]);
    expect(found).not.toContain("tags-below-band");
    expect(found).not.toContain("tags-above-band");
  });

  test("flags a delivery outside the vocabulary and one on a short line", () => {
    expect(rules([dseg([["A", words(12), "furious"]])])).toContain("delivery-unknown");
    expect(rules([dseg([["A", words(3), "curious"]])])).toContain("delivery-short-turn");
    expect(rules([dseg([["A", words(12), "curious"]])])).not.toContain("delivery-short-turn");
  });

  test("flags the same non-baseline delivery on three consecutive turns, once", () => {
    const d = (n: number): ["A" | "B", string, string] => [n % 2 ? "B" : "A", words(12, `s${n}x`), "amused"];
    const found = lintSegments([dseg([d(0), d(1), d(2), d(3)])]).findings.filter((f) => f.rule === "delivery-streak");
    expect(found.map((f) => f.turnIndex)).toEqual([2]);
    expect(rules([dseg([d(0), d(1), ["A", words(12, "gap"), undefined], d(3)])])).not.toContain("delivery-streak");
  });

  test("flags more than one CAPS emphasis in a turn but not source acronyms or host names", () => {
    expect(rules([dseg([["A", "Das ist KEIN Run und auch NICHT schnell."]])])).toContain("caps-emphasis");
    expect(rules([dseg([["A", "Das ist KEIN Run."]])])).not.toContain("caps-emphasis");
    expect(rules([dseg([["A", "DBOS und AGPL laufen."]])], { source: "DBOS AGPL" })).not.toContain("caps-emphasis");
  });

  test("counts tags and deliveries into the metrics and the profile summary", () => {
    const report = lintSegments([dseg([["A", `${words(14)} <short pause> ${words(5)}`, "curious"], ["B", "Ja."]])]);
    expect(report.metrics[0]).toMatchObject({ tags: 1, deliveries: 1 });
    expect(expressionSummary(report)).toMatchObject({ tags: 1, deliveries: 1, findings: {} });
  });
});

describe("lintSegmentation", () => {
  const texts = ["Wie geht das?", "So geht das.", "Und dann?", "Dann passiert das.", "Neue Sache."];
  test("reports unit count and size spread", () => {
    const r = lintSegmentation({ texts, segmentLengths: [5], units: [{ turnIndexes: [0, 1] }, { turnIndexes: [2, 3, 4] }], maxChars: 3000 });
    expect(r).toMatchObject({ units: 2, minChars: 25, maxChars: 38, findings: [] });
  });

  test("flags a unit over the limit, a cross-segment unit and a split question", () => {
    const over = lintSegmentation({ texts: ["x".repeat(60), "y".repeat(60)], segmentLengths: [2], units: [{ turnIndexes: [0, 1] }], maxChars: 100 });
    expect(over.findings[0]).toContain("over the 100 limit");
    const across = lintSegmentation({ texts, segmentLengths: [2, 3], units: [{ turnIndexes: [0, 1, 2] }, { turnIndexes: [3, 4] }], maxChars: 3000 });
    expect(across.findings.some((f) => f.includes("spans a segment boundary"))).toBe(true);
    const split = lintSegmentation({ texts, segmentLengths: [5], units: [{ turnIndexes: [0, 1, 2] }, { turnIndexes: [3, 4] }], maxChars: 3000 });
    expect(split.findings).toEqual(["unit 0: ends on a question whose answer opens unit 1"]);
  });

  test("a single over-long turn is not a finding", () => {
    expect(lintSegmentation({ texts: ["x".repeat(500)], segmentLengths: [1], units: [{ turnIndexes: [0] }], maxChars: 100 }).findings).toEqual([]);
  });
});
