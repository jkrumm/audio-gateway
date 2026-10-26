import { describe, expect, test } from "bun:test";
import { lintNotes, lintSegments, renderLintReport } from "./podcast-lint";
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
    const s = seg([["A", "<short pause> Dazu gibt es Records, kurz ADR."]]);
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
