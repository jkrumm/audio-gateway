/**
 * Hermetic tests for the podcast script writer. Stubs globalThis.fetch — no
 * network, no creds. See replicate-tts.test.ts for the shared env baseline.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// See audio.test.ts — config.ts is a process-wide singleton across bun test's
// shared module registry; every config-touching file sets this SAME baseline.
process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";
process.env["PROXY_API_KEY"] ??= "test-proxy-secret";
process.env["AUDIO_CALLER_TOKENS"] ??= "hermes=hermes-secret-token,macwhisper=macwhisper-secret-token";
process.env["TTS_PREP"] ??= "off";
process.env["TTS_CONCURRENCY"] ??= "4";

const {
  parseChatCompletionStream,
  planSegmentCount,
  parseOutline,
  parseSegmentTurns,
  sanitizeTurns,
  writePodcastScript,
  buildEpisodeProfile,
  loadShowBible,
  pruneUnrequestedDevices,
  V3_PODCAST_TAGS,
} = await import("./podcast-script");
const { EMPTY_DOSSIER } = await import("./podcast-types");
type EpisodeBrief = import("./podcast-types").EpisodeBrief;
type Dossier = import("./podcast-types").Dossier;
type Outline = import("./podcast-script").Outline;

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function chatCompletion(content: string): Response {
  return jsonRes({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
}

const HOSTS: [import("./podcast-script").PodcastHost, import("./podcast-script").PodcastHost] = [
  { id: "A", name: "Lena", voice: "Rachel" },
  { id: "B", name: "Marco", voice: "Roger" },
];

const BASE_BRIEF: EpisodeBrief = {
  format: "Erklärstück",
  rationale: "Die letzten Folgen waren Streitgespräche.",
  minutes: 12,
  segments: 3,
  roles: { A: "erklärt die Rechnung", B: "fragt für den Hörer nach" },
  tone: "ruhig, konkret",
  humor: "sparse",
  opening: "Direkt rein mit dem Thema, kein Cold Open.",
  closing: "Aufhören, wenn das Argument fertig ist.",
  rhythm: "Lange Turns bei A, kurze Einwürfe bei B.",
  devices: [],
  avoid: [],
  glossaryPolicy: "Namen erst als das einführen, was sie sind.",
};

const briefWith = (overrides: Partial<EpisodeBrief>): EpisodeBrief => ({ ...BASE_BRIEF, ...overrides });

describe("planSegmentCount", () => {
  test("clamps to the 3..9 range around ~4 minutes per segment", () => {
    expect(planSegmentCount(1)).toBe(3);
    expect(planSegmentCount(12)).toBe(3);
    expect(planSegmentCount(20)).toBe(5);
    expect(planSegmentCount(100)).toBe(9);
  });
});

describe("buildEpisodeProfile", () => {
  const words = (n: number): string => Array.from({ length: n }, () => "wort").join(" ");
  const scriptWith = (segments: import("./podcast-script").ScriptSegment[], topics: string[] = ["Maut", "Van"]) =>
    ({
      title: "t",
      description: "d",
      coverPrompt: "c",
      genres: [],
      language: "de" as const,
      segments,
      wordCount: 0,
      topics,
    }) satisfies import("./podcast-script").PodcastScript;

  test("computes lead from the word share and copies the brief's decisions", () => {
    const profile = buildEpisodeProfile({
      brief: briefWith({ format: "Erklärstück", humor: "none", opening: "Direkt rein.", minutes: 9 }),
      script: scriptWith([
        { title: "S1", turns: [{ speaker: "A", text: words(80) }, { speaker: "B", text: words(20) }] },
      ]),
      dossier: EMPTY_DOSSIER,
    });
    expect(profile.lead).toBe("A");
    expect(profile.format).toBe("Erklärstück");
    expect(profile.humor).toBe("none");
    expect(profile.opening).toBe("Direkt rein.");
    expect(profile.minutes).toBe(9);
    expect(profile.segmentCount).toBe(1);
    expect(profile.topics).toEqual(["Maut", "Van"]);
    expect(profile.durationSeconds).toBeNull();
  });

  test("a share within 10 percentage points is balanced, beyond it is not", () => {
    const balanced = buildEpisodeProfile({
      brief: BASE_BRIEF,
      script: scriptWith([{ title: "S1", turns: [{ speaker: "A", text: words(55) }, { speaker: "B", text: words(45) }] }]),
      dossier: EMPTY_DOSSIER,
    });
    expect(balanced.lead).toBe("balanced");

    const leaning = buildEpisodeProfile({
      brief: BASE_BRIEF,
      script: scriptWith([{ title: "S1", turns: [{ speaker: "A", text: words(44) }, { speaker: "B", text: words(56) }] }]),
      dossier: EMPTY_DOSSIER,
    });
    expect(leaning.lead).toBe("B");
  });

  test("an empty script is balanced rather than a division by zero", () => {
    const profile = buildEpisodeProfile({ brief: BASE_BRIEF, script: scriptWith([]), dossier: EMPTY_DOSSIER });
    expect(profile.lead).toBe("balanced");
    expect(profile.segmentCount).toBe(0);
  });

  test("counts the dossier's tool calls, research calls separately", () => {
    const dossier: Dossier = {
      ...EMPTY_DOSSIER,
      toolCalls: [
        { tool: "brain_search", args: {}, ok: true, ms: 5 },
        { tool: "research", args: {}, ok: true, ms: 900 },
        { tool: "research", args: {}, ok: false, ms: 900 },
      ],
    };
    const profile = buildEpisodeProfile({ brief: BASE_BRIEF, script: scriptWith([]), dossier });
    expect(profile.toolCalls).toBe(3);
    expect(profile.researchCalls).toBe(2);
  });
});

describe("parseOutline", () => {
  test("parses a clean JSON object", () => {
    const outline = parseOutline(
      JSON.stringify({
        title: "The Plan",
        description: "A short description.",
        cover_prompt: "A van at sunset",
        genres: ["Travel"],
        motif: "the broken coffee machine",
        segments: [{ title: "Cold open", goal: "hook", key_facts: ["fact one"], target_words: 200, tension: "will it work" }],
      }),
    );
    expect(outline.title).toBe("The Plan");
    expect(outline.motif).toBe("the broken coffee machine");
    expect(outline.segments).toHaveLength(1);
    expect(outline.segments[0]?.keyFacts).toEqual(["fact one"]);
  });

  test("tolerates a fenced JSON block with leading prose", () => {
    const raw = `Sure, here is the outline:\n\`\`\`json\n${JSON.stringify({
      title: "T",
      description: "D",
      cover_prompt: "P",
      genres: [],
      segments: [{ title: "S1", goal: "g", key_facts: [], target_words: 100, tension: "t" }],
    })}\n\`\`\`\nLet me know if you need changes.`;
    const outline = parseOutline(raw);
    expect(outline.title).toBe("T");
    expect(outline.segments).toHaveLength(1);
  });

  test("throws when segments are missing", () => {
    expect(() => parseOutline(JSON.stringify({ title: "T" }))).toThrow();
  });

  test("parses the dramaturgy fields when present", () => {
    const outline = parseOutline(
      JSON.stringify({
        title: "The Plan",
        description: "A short description.",
        cover_prompt: "A van at sunset",
        genres: ["Travel"],
        motif: "the broken coffee machine",
        through_line: "Will the van actually make the mountain pass?",
        hook: "The mechanic just said the word 'maybe'.",
        reveals: [{ text: "The pass has a weight limit.", segment: 1 }],
        digressions: [{ beat: "A story about a flat tyre in Portugal.", segment: 0, return_hook: "Anyway, back to the van." }],
        segments: [
          { title: "Cold open", goal: "hook", key_facts: ["fact one"], target_words: 200, tension: "will it work" },
          { title: "Middle", goal: "explain", key_facts: [], target_words: 200, tension: "is it enough" },
        ],
      }),
    );
    expect(outline.throughLine).toBe("Will the van actually make the mountain pass?");
    expect(outline.hook).toBe("The mechanic just said the word 'maybe'.");
    expect(outline.reveals).toEqual([{ text: "The pass has a weight limit.", segmentIndex: 1 }]);
    expect(outline.digressions).toEqual([
      { beat: "A story about a flat tyre in Portugal.", segmentIndex: 0, returnHook: "Anyway, back to the van." },
    ]);
  });

  test("defaults the dramaturgy fields to empty/blank when absent (older fixtures still parse)", () => {
    const outline = parseOutline(
      JSON.stringify({
        title: "T",
        description: "D",
        cover_prompt: "P",
        genres: [],
        segments: [{ title: "S1", goal: "g", key_facts: [], target_words: 100, tension: "t" }],
      }),
    );
    expect(outline.throughLine).toBe("");
    expect(outline.hook).toBe("");
    expect(outline.reveals).toEqual([]);
    expect(outline.digressions).toEqual([]);
  });

  test("accepts an outline that deliberately declines every dramaturgy device (empty strings and arrays)", () => {
    const outline = parseOutline(
      JSON.stringify({
        title: "Ein dichter Durchgang",
        description: "D",
        cover_prompt: "P",
        genres: ["Tech"],
        motif: "",
        through_line: "",
        hook: "",
        reveals: [],
        digressions: [],
        segments: [{ title: "S1", goal: "g", key_facts: [], target_words: 700, tension: "" }],
      }),
    );
    expect(outline.motif).toBe("");
    expect(outline.hook).toBe("");
    expect(outline.throughLine).toBe("");
    expect(outline.reveals).toEqual([]);
    expect(outline.digressions).toEqual([]);
    expect(outline.segments).toHaveLength(1);
  });

  test("clamps a reveal/digression segment index onto a real segment", () => {
    const outline = parseOutline(
      JSON.stringify({
        title: "T",
        description: "D",
        cover_prompt: "P",
        genres: [],
        reveals: [{ text: "Out of range reveal", segment: 99 }],
        digressions: [{ beat: "Out of range digression", segment: -5, return_hook: "back" }],
        segments: [{ title: "S1", goal: "g", key_facts: [], target_words: 100, tension: "t" }],
      }),
    );
    expect(outline.reveals).toEqual([{ text: "Out of range reveal", segmentIndex: 0 }]);
    expect(outline.digressions).toEqual([{ beat: "Out of range digression", segmentIndex: 0, returnHook: "back" }]);
  });
});

describe("pruneUnrequestedDevices", () => {
  const outlineWithAllDevices: Outline = {
    title: "T",
    description: "D",
    coverPrompt: "P",
    genres: [],
    motif: "the broken coffee machine",
    throughLine: "Will the van make the pass?",
    hook: "The mechanic just said the word 'maybe'.",
    reveals: [{ text: "The pass has a weight limit.", segmentIndex: 1 }],
    digressions: [{ beat: "A story about a flat tyre in Portugal.", segmentIndex: 0, returnHook: "Anyway, back to the van." }],
    segments: [{ title: "S1", goal: "g", keyFacts: [], targetWords: 100, tension: "t" }],
  };

  test("blanks hook, motif, reveals and digressions when the brief lists no devices", () => {
    const pruned = pruneUnrequestedDevices(outlineWithAllDevices, briefWith({ devices: [] }));
    expect(pruned.hook).toBe("");
    expect(pruned.motif).toBe("");
    expect(pruned.reveals).toEqual([]);
    expect(pruned.digressions).toEqual([]);
    // Everything else on the outline is untouched.
    expect(pruned.throughLine).toBe(outlineWithAllDevices.throughLine);
    expect(pruned.title).toBe(outlineWithAllDevices.title);
  });

  test("keeps only the devices the brief actually asked for", () => {
    const pruned = pruneUnrequestedDevices(
      outlineWithAllDevices,
      briefWith({ devices: ["One genuine live disagreement between the hosts", "Withheld: the total cost until the end"] }),
    );
    expect(pruned.reveals).toEqual(outlineWithAllDevices.reveals);
    expect(pruned.hook).toBe("");
    expect(pruned.motif).toBe("");
    expect(pruned.digressions).toEqual([]);
  });
});

describe("parseSegmentTurns", () => {
  test("parses clean turns", () => {
    const turns = parseSegmentTurns(JSON.stringify({ turns: [{ speaker: "A", text: "Hallo." }, { speaker: "B", text: "Hi." }] }));
    expect(turns).toEqual([{ speaker: "A", text: "Hallo." }, { speaker: "B", text: "Hi." }]);
  });

  test("strips a leaked 'Lena:' style label the model repeated in the text", () => {
    const turns = parseSegmentTurns(JSON.stringify({ turns: [{ speaker: "A", text: "Lena: Das ist spannend." }] }));
    expect(turns).toEqual([{ speaker: "A", text: "Das ist spannend." }]);
  });

  test("tolerates fenced JSON with leading prose and drops empty turns", () => {
    const raw = `Here you go:\n\`\`\`json\n${JSON.stringify({
      turns: [{ speaker: "A", text: "" }, { speaker: "B", text: "Echt jetzt?" }],
    })}\n\`\`\``;
    const turns = parseSegmentTurns(raw);
    expect(turns).toEqual([{ speaker: "B", text: "Echt jetzt?" }]);
  });
});

describe("sanitizeTurns", () => {
  test("removes a disallowed tag but keeps an allowed one", () => {
    const [t1, t2] = sanitizeTurns([
      { speaker: "A", text: "[not-a-real-tag] Hallo da." },
      { speaker: "B", text: `Na klar, das ist genau der Punkt. ${V3_PODCAST_TAGS[0]} Und deshalb rechnen wir das jetzt einmal komplett durch, Schritt für Schritt.` },
    ]);
    expect(t1?.text).toBe("Hallo da.");
    expect(t2?.text).toContain(V3_PODCAST_TAGS[0]);
  });

  test("strips markdown and bullets, leaves digits untouched", () => {
    const [t1] = sanitizeTurns([{ speaker: "A", text: "- **330** Euro pro Nacht, klar?" }]);
    expect(t1?.text).toBe("330 Euro pro Nacht, klar?");
  });

  test("splits a long turn at sentence boundaries, keeping the same speaker", () => {
    const sentence = "Das ist ein Satz mit genug Inhalt, um Platz zu brauchen.";
    const longText = `${sentence} ${sentence} ${sentence} ${sentence} ${sentence}`;
    const [turn] = [{ speaker: "A" as const, text: longText }];
    const out = sanitizeTurns([turn], 100);
    expect(out.length).toBeGreaterThan(1);
    for (const t of out) {
      expect(t.speaker).toBe("A");
      expect(t.text.length).toBeLessThanOrEqual(100 + sentence.length); // one sentence may push slightly over on its own
    }
    // no content lost
    expect(out.map((t) => t.text).join(" ")).toContain("Das ist ein Satz");
  });

  test("merges a short fragment into its same-speaker predecessor", () => {
    const out = sanitizeTurns([
      { speaker: "A", text: "Echt?" },
      { speaker: "A", text: "Das habe ich nicht erwartet." },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.text).toBe("Echt? Das habe ich nicht erwartet.");
  });

  test("does not merge across a speaker change", () => {
    const out = sanitizeTurns([
      { speaker: "A", text: "Echt?" },
      { speaker: "B", text: "Ja, wirklich." },
    ]);
    expect(out).toHaveLength(2);
  });

  test("does not merge a short fragment when the merge would exceed maxChars", () => {
    const almostFull = "x".repeat(38); // < MERGE_SHORT_TURN_CHARS (40), leaves the predecessor eligible to merge into
    const out = sanitizeTurns(
      [
        { speaker: "A", text: almostFull },
        { speaker: "A", text: "Echt?" },
      ],
      40,
    );
    // Merging would produce 38 + 1 (space) + 5 = 44 chars, over the 40-char cap — so the merge must be skipped.
    expect(out).toHaveLength(2);
    expect(out[0]?.text).toBe(almostFull);
    expect(out[1]?.text).toBe("Echt?");
  });

  test("removes a bracketed stage direction longer than the old 30-char cap", () => {
    const longDirection = "[a very long stage direction that runs well past thirty characters]";
    const [turn] = sanitizeTurns([{ speaker: "A", text: `${longDirection} Hallo da.` }]);
    expect(turn?.text).toBe("Hallo da.");
  });
});

const OUTLINE_SEGMENTS = [
  { title: "Cold open", goal: "hook the listener", key_facts: ["fact A"], target_words: 100, tension: "will it work" },
  { title: "Middle", goal: "explain the plan", key_facts: ["fact B"], target_words: 100, tension: "is it enough time" },
  { title: "Wrap-up", goal: "close the episode", key_facts: ["fact C"], target_words: 100, tension: "what's left open" },
];

function outlineResponse(extra: Record<string, unknown> = {}): Response {
  return chatCompletion(
    JSON.stringify({
      title: "Der Roadtrip-Plan",
      description: "Eine kurze Beschreibung.",
      cover_prompt: "A camper van on a coastal road at golden hour",
      genres: ["Travel"],
      segments: OUTLINE_SEGMENTS,
      ...extra,
    }),
  );
}

function segmentResponse(index: number): Response {
  return chatCompletion(
    JSON.stringify({
      turns: [
        { speaker: "A", text: `Segment ${index} Zeile eins von Lena.` },
        { speaker: "B", text: `Segment ${index} Zeile zwei von Marco.` },
      ],
    }),
  );
}

function metadataResponse(): Response {
  return chatCompletion(
    JSON.stringify({
      title: "Der finale Titel",
      description: "Die finale Beschreibung fürs Publikum.",
      cover_prompt: "A painterly camper van on a coastal road at dusk",
      genres: ["Travel", "Planning"],
      chapters: [
        { segment: 0, title: "Der Aufbruch" },
        { segment: 1, title: "Die Route" },
        { segment: 2, title: "Der Abschluss" },
      ],
    }),
  );
}

const BASE_REQUEST = {
  source: "Der Van kostet dreihundert Euro pro Nacht.",
  brief: "Für einen Freund, der einen Roadtrip plant.",
  language: "de" as const,
  minutes: 12,
  hosts: HOSTS,
  series: "Roadtrip Radio",
  dossier: EMPTY_DOSSIER,
  episodeBrief: BASE_BRIEF,
};

const MODELS = {
  outline: "outline-model",
  write: "write-model",
  review: ["review-model-1", "review-model-2"],
  metadata: "metadata-model",
};

describe("writePodcastScript", () => {
  test("review: false, metadata: false writes an outline then every segment in parallel, preserving order and summing wordCount, with no review/revision/metadata calls", async () => {
    const calls: string[] = [];
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        calls.push("outline");
        return outlineResponse();
      }
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      if (!match) throw new Error(`unexpected prompt: ${systemPrompt.slice(0, 100)}`);
      calls.push("segment");
      const index = Number(match[1]) - 1;
      return segmentResponse(index);
    });

    const script = await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 2, review: false, metadata: false });

    expect(script.title).toBe("Der Roadtrip-Plan");
    expect(script.language).toBe("de");
    expect(script.genres).toEqual(["Travel"]);
    expect(script.segments).toHaveLength(3);
    // Order preserved regardless of concurrent completion order.
    expect(script.segments.map((s) => s.title)).toEqual(["Cold open", "Middle", "Wrap-up"]);
    for (const [i, segment] of script.segments.entries()) {
      expect(segment.turns[0]?.text).toContain(`Segment ${i} `);
    }
    const expectedWordCount = script.segments.reduce(
      (sum, seg) => sum + seg.turns.reduce((s, t) => s + (t.text.match(/\S+/g) ?? []).length, 0),
      0,
    );
    expect(script.wordCount).toBe(expectedWordCount);
    expect(script.wordCount).toBeGreaterThan(0);
    // Old behaviour: exactly one outline call + one call per segment, nothing else.
    expect(calls).toEqual(["outline", "segment", "segment", "segment"]);
  });

  test("review: true, metadata: true runs the full role split — outline on the outline model, segments and revisions on the write model, every reviewer role on every review model in parallel, then metadata", async () => {
    const calls: Array<{ stage: string; model: string }> = [];

    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      const model = body.model;

      if (systemPrompt.includes("You are writing the OUTLINE")) {
        calls.push({ stage: "outline", model });
        return outlineResponse();
      }

      if (systemPrompt.includes("You are the final METADATA EDITOR")) {
        calls.push({ stage: "metadata", model });
        return metadataResponse();
      }

      if (systemPrompt.includes("You are a reviewer from a different model family")) {
        if (systemPrompt.includes("You are the DRAMATURGE")) {
          calls.push({ stage: "review-dramaturge", model });
          return chatCompletion(
            JSON.stringify({
              notes: [{ segment: 0, turn: 0, note: "Open with the hook, not a summary." }],
              verdict: "Needs one fix in the cold open.",
            }),
          );
        }
        if (systemPrompt.includes("You are the CONVERSATION COACH")) {
          calls.push({ stage: "review-coach", model });
          return chatCompletion(JSON.stringify({ notes: [], verdict: "Sounds natural." }));
        }
        calls.push({ stage: "review-fact-editor", model });
        return chatCompletion(
          JSON.stringify({
            notes: [{ segment: null, turn: null, note: "Spell out all currency amounts." }],
            verdict: "One episode-wide fix needed.",
          }),
        );
      }

      if (systemPrompt.includes("You are REVISING ONE SEGMENT")) {
        calls.push({ stage: "revise", model });
        const match = /"([^"]+)" — based on editorial notes/.exec(systemPrompt);
        return chatCompletion(
          JSON.stringify({
            turns: [
              { speaker: "A", text: `Revised ${match?.[1] ?? "?"} Zeile eins.` },
              { speaker: "B", text: "Revised Zeile zwei." },
            ],
          }),
        );
      }

      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      if (!match) throw new Error(`unexpected prompt: ${systemPrompt.slice(0, 100)}`);
      calls.push({ stage: "segment", model });
      const index = Number(match[1]) - 1;
      return segmentResponse(index);
    });

    const script = await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 2, review: true });

    // Exact call sequence: 1 outline, 3 segments, 3 roles x 2 review models = 6 reviews,
    // 1 revision (only segment 0 had a targeted note), 1 metadata — each on the right model.
    expect(calls.filter((c) => c.stage === "outline")).toEqual([{ stage: "outline", model: MODELS.outline }]);
    const segmentCalls = calls.filter((c) => c.stage === "segment");
    expect(segmentCalls).toHaveLength(3);
    expect(segmentCalls.every((c) => c.model === MODELS.write)).toBe(true);
    const reviewCalls = calls.filter((c) => c.stage.startsWith("review-"));
    expect(reviewCalls).toHaveLength(6);
    expect(reviewCalls.filter((c) => c.stage === "review-dramaturge")).toHaveLength(2);
    expect(reviewCalls.filter((c) => c.stage === "review-coach")).toHaveLength(2);
    expect(reviewCalls.filter((c) => c.stage === "review-fact-editor")).toHaveLength(2);
    expect(reviewCalls.filter((c) => c.model === MODELS.review[0])).toHaveLength(3);
    expect(reviewCalls.filter((c) => c.model === MODELS.review[1])).toHaveLength(3);
    const reviseCalls = calls.filter((c) => c.stage === "revise");
    expect(reviseCalls).toHaveLength(1);
    expect(reviseCalls[0]?.model).toBe(MODELS.write);
    expect(calls.filter((c) => c.stage === "metadata")).toEqual([{ stage: "metadata", model: MODELS.metadata }]);

    // Ordering across phases: reviews strictly after all segments, revision strictly after
    // all reviews, metadata strictly after the revision.
    const stages = calls.map((c) => c.stage);
    const lastSegmentIdx = stages.lastIndexOf("segment");
    const firstReviewIdx = stages.findIndex((s) => s.startsWith("review-"));
    const reviseIdx = stages.indexOf("revise");
    const metadataIdx = stages.indexOf("metadata");
    expect(firstReviewIdx).toBeGreaterThan(lastSegmentIdx);
    expect(reviseIdx).toBeGreaterThan(stages.lastIndexOf("review-dramaturge"));
    expect(reviseIdx).toBeGreaterThan(stages.lastIndexOf("review-coach"));
    expect(reviseIdx).toBeGreaterThan(stages.lastIndexOf("review-fact-editor"));
    expect(metadataIdx).toBeGreaterThan(reviseIdx);

    // Segment 0 carries the revised turns; segments 1 and 2 are untouched.
    expect(script.segments[0]?.turns[0]?.text).toContain("Revised Cold open");
    expect(script.segments[1]?.turns[0]?.text).toBe("Segment 1 Zeile eins von Lena.");
    expect(script.segments[2]?.turns[0]?.text).toBe("Segment 2 Zeile eins von Lena.");

    // The metadata pass's chapter titles land on the segments; title/description/coverPrompt
    // come from metadata, not from the outline drafts.
    expect(script.title).toBe("Der finale Titel");
    expect(script.description).toBe("Die finale Beschreibung fürs Publikum.");
    expect(script.coverPrompt).toBe("A painterly camper van on a coastal road at dusk");
    expect(script.genres).toEqual(["Travel", "Planning"]);
    expect(script.segments.map((s) => s.title)).toEqual(["Der Aufbruch", "Die Route", "Der Abschluss"]);
  });

  test("metadata failure falls back to the outline's title/description/coverPrompt/genres and segment titles, job still succeeds", async () => {
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) return outlineResponse();
      if (systemPrompt.includes("You are the final METADATA EDITOR")) return chatCompletion("not JSON at all");
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      if (!match) throw new Error(`unexpected prompt: ${systemPrompt.slice(0, 100)}`);
      const index = Number(match[1]) - 1;
      return segmentResponse(index);
    });

    const script = await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 2, review: false });

    expect(script.title).toBe("Der Roadtrip-Plan");
    expect(script.description).toBe("Eine kurze Beschreibung.");
    expect(script.coverPrompt).toBe("A camper van on a coastal road at golden hour");
    expect(script.genres).toEqual(["Travel"]);
    expect(script.segments.map((s) => s.title)).toEqual(["Cold open", "Middle", "Wrap-up"]);
  });

  test("show bible is loaded and injected verbatim into the outline system prompt", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "audio-gateway-show-bible-test-"));
    const showBiblePath = join(tmpRoot, "show-bible.md");
    writeFileSync(showBiblePath, "# House Style\n\nHosts never say 'als KI'.");

    let outlineSystemPrompt = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        outlineSystemPrompt = systemPrompt;
        return outlineResponse();
      }
      return segmentResponse(0);
    });

    await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 2, review: false, metadata: false, showBiblePath });

    expect(outlineSystemPrompt).toContain("SHOW BIBLE (house style — binding)");
    expect(outlineSystemPrompt).toContain("Hosts never say 'als KI'.");
  });

  test("the episode brief drives segment count and target words, not planSegmentCount(minutes)", async () => {
    let outlineSystemPrompt = "";
    const segmentPrompts: string[] = [];
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        outlineSystemPrompt = systemPrompt;
        return chatCompletion(
          JSON.stringify({
            title: "T",
            description: "D",
            cover_prompt: "P",
            genres: [],
            segments: [{ title: "Nur eins", goal: "g", key_facts: [], target_words: 500, tension: "t" }],
          }),
        );
      }
      segmentPrompts.push(systemPrompt);
      return segmentResponse(0);
    });

    // minutes: 12 would give planSegmentCount -> 3 segments and 1680 target words.
    await writePodcastScript(
      { ...BASE_REQUEST, episodeBrief: briefWith({ segments: 1, minutes: 5 }) },
      { models: MODELS, concurrency: 2, review: false, metadata: false },
    );

    expect(outlineSystemPrompt).toContain("Produce exactly 1 segments");
    expect(outlineSystemPrompt).toContain("about 5 minutes");
    expect(outlineSystemPrompt).toContain("about 700 words in total");
    expect(segmentPrompts).toHaveLength(1);
    expect(segmentPrompts[0]).toContain("ONE SEGMENT (1 of 1)");
  });

  test("the brief's opening/closing replace the hardcoded cold open and three takeaways", async () => {
    let outlineSystemPrompt = "";
    const segmentPrompts: string[] = [];
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        outlineSystemPrompt = systemPrompt;
        return outlineResponse();
      }
      segmentPrompts.push(systemPrompt);
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      return segmentResponse(Number(match?.[1] ?? 1) - 1);
    });

    await writePodcastScript(
      {
        ...BASE_REQUEST,
        episodeBrief: briefWith({
          opening: "Straight in with the number nobody expected, no station intro.",
          closing: "Stop when the argument is finished.",
        }),
      },
      { models: MODELS, concurrency: 3, review: false, metadata: false },
    );

    // No formula left anywhere in the prompts.
    for (const prompt of [outlineSystemPrompt, ...segmentPrompts]) {
      expect(prompt).not.toContain("cold open plus a short intro");
      expect(prompt).not.toContain("three concrete takeaways");
      expect(prompt).not.toContain("one running joke or motif across the episode");
    }
    expect(outlineSystemPrompt).toContain("Straight in with the number nobody expected");
    expect(outlineSystemPrompt).toContain("Stop when the argument is finished.");

    const first = segmentPrompts.find((p) => p.includes("ONE SEGMENT (1 of 3)")) ?? "";
    const last = segmentPrompts.find((p) => p.includes("ONE SEGMENT (3 of 3)")) ?? "";
    expect(first).toContain("the brief's OPENING is binding: Straight in with the number nobody expected");
    expect(first).toContain("Do not add a cold open");
    expect(last).toContain("the brief's CLOSING is binding: Stop when the argument is finished.");
    expect(last).toContain("Do not add takeaways");
  });

  test("devices, avoid and the humor level are rendered only when the brief sets them", async () => {
    const capture = async (episodeBrief: EpisodeBrief): Promise<string> => {
      let prompt = "";
      setFetch(async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
        const systemPrompt = body.messages[0]?.content ?? "";
        if (systemPrompt.includes("You are writing the OUTLINE")) {
          prompt = systemPrompt;
          return outlineResponse();
        }
        return segmentResponse(0);
      });
      await writePodcastScript({ ...BASE_REQUEST, episodeBrief }, { models: MODELS, concurrency: 3, review: false, metadata: false });
      return prompt;
    };

    const bare = await capture(briefWith({ devices: [], avoid: [], humor: "none" }));
    expect(bare).not.toContain("Devices to use");
    expect(bare).not.toContain("Avoid (patterns from recent episodes");
    expect(bare).toContain("Humor: none — write no jokes at all.");

    const rich = await capture(
      briefWith({ devices: ["a motif: the broken coffee machine"], avoid: ["the number-then-Warte cold open"], humor: "natural" }),
    );
    expect(rich).toContain("Devices to use (and only these): a motif: the broken coffee machine");
    expect(rich).toContain("Avoid (patterns from recent episodes, do not repeat them): the number-then-Warte cold open");
    expect(rich).toContain("Humor: natural — let humor happen");
  });

  test("the dossier's additions, glossary, prior coverage and open questions reach the outline and segment user content", async () => {
    const userContents: string[] = [];
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      userContents.push(body.messages[1]?.content ?? "");
      if (systemPrompt.includes("You are writing the OUTLINE")) return outlineResponse();
      return segmentResponse(0);
    });

    await writePodcastScript(
      {
        ...BASE_REQUEST,
        dossier: {
          summary: "Es geht um die Maut.",
          additions: [{ source: "brain: Areas/Travel/Maut.md", text: "Die Vignette gilt zehn Tage." }],
          glossary: [{ term: "ASFINAG", plain: "die Firma, die Österreichs Autobahnen betreibt" }],
          priorCoverage: [{ episodeId: "e1", title: "Folge eins", covered: "die Route über den Brenner" }],
          openQuestions: ["Gilt die Vignette auch für den Anhänger?"],
          toolCalls: [],
        },
      },
      { models: MODELS, concurrency: 3, review: false, metadata: false },
    );

    expect(userContents.length).toBeGreaterThan(1);
    for (const content of userContents) {
      expect(content).toContain("[brain: Areas/Travel/Maut.md]\nDie Vignette gilt zehn Tage.");
      expect(content).toContain("ASFINAG — die Firma, die Österreichs Autobahnen betreibt");
      expect(content).toContain("PRIOR COVERAGE (do not repeat");
      expect(content).toContain("Folge eins: die Route über den Brenner");
      expect(content).toContain("Gilt die Vignette auch für den Anhänger?");
    }
  });

  test("an empty dossier renders no ADDITIONS/GLOSSARY headings at all", async () => {
    let outlineUserContent = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        outlineUserContent = body.messages[1]?.content ?? "";
        return outlineResponse();
      }
      return segmentResponse(0);
    });

    await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 3, review: false, metadata: false });

    expect(outlineUserContent).not.toContain("ADDITIONS");
    expect(outlineUserContent).not.toContain("GLOSSARY");
    expect(outlineUserContent).not.toContain("PRIOR COVERAGE");
    expect(outlineUserContent).not.toContain("OPEN QUESTIONS");
  });

  test("the dramaturge reviews against the brief; the fact editor flags figure clusters and unintroduced names", async () => {
    let dramaturgePrompt = "";
    let factEditorPrompt = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) return outlineResponse();
      if (systemPrompt.includes("You are the DRAMATURGE")) {
        dramaturgePrompt = systemPrompt;
        return chatCompletion(JSON.stringify({ notes: [], verdict: "ok" }));
      }
      if (systemPrompt.includes("You are the FACT & SPEECH EDITOR")) {
        factEditorPrompt = systemPrompt;
        return chatCompletion(JSON.stringify({ notes: [], verdict: "ok" }));
      }
      if (systemPrompt.includes("You are the CONVERSATION COACH")) return chatCompletion(JSON.stringify({ notes: [], verdict: "ok" }));
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      return segmentResponse(Number(match?.[1] ?? 1) - 1);
    });

    await writePodcastScript(
      { ...BASE_REQUEST, episodeBrief: briefWith({ format: "Kurzbriefing" }) },
      { models: { ...MODELS, review: ["review-model-1"] }, concurrency: 3, review: true, metadata: false },
    );

    expect(dramaturgePrompt).toContain("AGAINST ITS EPISODE BRIEF");
    expect(dramaturgePrompt).toContain("THE BRIEF THIS EPISODE OWES:");
    expect(dramaturgePrompt).toContain("Format: Kurzbriefing");
    expect(dramaturgePrompt).toContain("devices NOBODY asked for");
    expect(factEditorPrompt).toContain("FIGURE CLUSTERS and UNINTRODUCED NAMES");
    expect(factEditorPrompt).toContain("before the hosts said what it IS in plain words");
  });

  test("the numbers-and-names non-negotiable is in every writer prompt", async () => {
    const prompts: string[] = [];
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      prompts.push(systemPrompt);
      if (systemPrompt.includes("You are writing the OUTLINE")) return outlineResponse();
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      return segmentResponse(Number(match?.[1] ?? 1) - 1);
    });

    await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 3, review: false, metadata: false });

    expect(prompts).toHaveLength(4);
    for (const prompt of prompts) {
      expect(prompt).toContain("One figure per sentence");
      expect(prompt).toContain("Round, unless the precision IS the point");
      expect(prompt).toContain("WHAT IT IS before WHAT IT IS CALLED");
      expect(prompt).toContain("Open questions stay open");
      // Roles come from the brief, never from a hardcoded host description.
      expect(prompt).not.toContain("the curious co-host");
      expect(prompt).toContain("comes from the EPISODE BRIEF below");
    }
  });

  test("the metadata pass's topics land on the script; a skipped metadata pass leaves them empty", async () => {
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) return outlineResponse();
      if (systemPrompt.includes("You are the final METADATA EDITOR")) {
        return chatCompletion(
          JSON.stringify({
            title: "T",
            description: "D",
            cover_prompt: "C",
            genres: ["Travel"],
            topics: ["Maut", "Vignette", "Van"],
            chapters: [],
          }),
        );
      }
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      return segmentResponse(Number(match?.[1] ?? 1) - 1);
    });

    const withMetadata = await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 3, review: false });
    expect(withMetadata.topics).toEqual(["Maut", "Vignette", "Van"]);

    const withoutMetadata = await writePodcastScript(BASE_REQUEST, { models: MODELS, concurrency: 3, review: false, metadata: false });
    expect(withoutMetadata.topics).toEqual([]);
  });

  test("a missing show bible file does not fail the outline prompt", async () => {
    let outlineSystemPrompt = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        outlineSystemPrompt = systemPrompt;
        return outlineResponse();
      }
      return segmentResponse(0);
    });

    await writePodcastScript(BASE_REQUEST, {
      models: MODELS,
      concurrency: 2,
      review: false,
      metadata: false,
      showBiblePath: join(tmpdir(), "audio-gateway-show-bible-test-does-not-exist", "show-bible.md"),
    });

    expect(outlineSystemPrompt).not.toContain("SHOW BIBLE");
  });

  test("an outline hook/motif/reveal/digression the brief did not ask for never reaches the segment writers", async () => {
    const segmentPrompts: Array<{ system: string; user: string }> = [];
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        return outlineResponse({
          hook: "A concrete cold-open beat nobody asked for.",
          motif: "an invented running joke",
          reveals: [{ text: "A twist nobody asked for.", segment: 1 }],
          digressions: [{ beat: "An anecdote nobody asked for.", segment: 0, return_hook: "back to it" }],
        });
      }
      segmentPrompts.push({ system: systemPrompt, user: body.messages[1]?.content ?? "" });
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      return segmentResponse(Number(match?.[1] ?? 1) - 1);
    });

    await writePodcastScript(
      { ...BASE_REQUEST, episodeBrief: briefWith({ devices: [] }) },
      { models: MODELS, concurrency: 3, review: false, metadata: false },
    );

    expect(segmentPrompts).toHaveLength(3);
    for (const { system, user } of segmentPrompts) {
      expect(system).not.toContain("Running motif of the episode");
      expect(user).not.toContain("HOOK (open this segment");
      expect(user).not.toContain("REVEALS TO LAND IN THIS SEGMENT");
      expect(user).not.toContain("DO NOT REVEAL YET");
      expect(user).not.toContain("DIGRESSION FOR THIS SEGMENT");
    }
  });

  test("the revision pass's user content includes the dossier's ADDITIONS/GLOSSARY/PRIOR COVERAGE/OPEN QUESTIONS sections", async () => {
    let revisionUserContent = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) return outlineResponse();
      if (systemPrompt.includes("You are a reviewer from a different model family")) {
        return chatCompletion(JSON.stringify({ notes: [{ segment: 0, turn: 0, note: "Tighten the opening line." }], verdict: "ok" }));
      }
      if (systemPrompt.includes("You are REVISING ONE SEGMENT")) {
        revisionUserContent = body.messages[1]?.content ?? "";
        return chatCompletion(JSON.stringify({ turns: [{ speaker: "A", text: "Revised line." }] }));
      }
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      return segmentResponse(Number(match?.[1] ?? 1) - 1);
    });

    await writePodcastScript(
      {
        ...BASE_REQUEST,
        dossier: {
          summary: "Es geht um die Maut.",
          additions: [{ source: "brain: Areas/Travel/Maut.md", text: "Die Vignette gilt zehn Tage." }],
          glossary: [{ term: "ASFINAG", plain: "die Firma, die Österreichs Autobahnen betreibt" }],
          priorCoverage: [{ episodeId: "e1", title: "Folge eins", covered: "die Route über den Brenner" }],
          openQuestions: ["Gilt die Vignette auch für den Anhänger?"],
          toolCalls: [],
        },
      },
      { models: { ...MODELS, review: ["review-model-1"] }, concurrency: 3, review: true, metadata: false },
    );

    expect(revisionUserContent).toContain("[brain: Areas/Travel/Maut.md]\nDie Vignette gilt zehn Tage.");
    expect(revisionUserContent).toContain("ASFINAG — die Firma, die Österreichs Autobahnen betreibt");
    expect(revisionUserContent).toContain("PRIOR COVERAGE (do not repeat");
    expect(revisionUserContent).toContain("Folge eins: die Route über den Brenner");
    expect(revisionUserContent).toContain("Gilt die Vignette auch für den Anhänger?");
  });
});

describe("loadShowBible", () => {
  test("reads a file's contents", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "audio-gateway-load-show-bible-test-"));
    const path = join(tmpRoot, "show-bible.md");
    writeFileSync(path, "House style rules.");
    expect(await loadShowBible(path)).toBe("House style rules.");
  });

  test("resolves to an empty string when the file is missing", async () => {
    const path = join(tmpdir(), "audio-gateway-load-show-bible-test-missing", "show-bible.md");
    expect(await loadShowBible(path)).toBe("");
  });
});

describe("parseChatCompletionStream", () => {
  test("stitches SSE deltas and picks up the trailing usage chunk", () => {
    const body = [
      'data: {"choices":[{"delta":{"role":"assistant","content":"{\\"a\\":"}}]}',
      'data: {"choices":[{"delta":{"content":"1}"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":4}}',
      "data: [DONE]",
      "",
    ].join("\n");
    const parsed = parseChatCompletionStream(body);
    expect(parsed.content).toBe('{"a":1}');
    expect(parsed.usage?.completion_tokens).toBe(4);
  });

  test("falls back to a plain non-stream JSON body", () => {
    const parsed = parseChatCompletionStream(JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { completion_tokens: 1 } }));
    expect(parsed.content).toBe("hi");
    expect(parsed.usage?.completion_tokens).toBe(1);
  });
});

describe("tags on short turns", () => {
  test("a tag on a short interjection is dropped, on a long turn it stays", () => {
    const short = sanitizeTurns([{ speaker: "B", text: "[laughs] Da ist sie." }]);
    expect(short[0]?.text).toBe("Da ist sie.");
    const long = sanitizeTurns([
      { speaker: "A", text: "Das ist der Punkt, den fast jeder übersieht. [sighs] Diesel kostet ungefähr das Dreifache von dem, was du an Maut zahlst, und genau das dreht die Planung um." },
    ]);
    expect(long[0]?.text).toContain("[sighs]");
  });
});

describe("length governor", () => {
  test("normalizeOutlineTargets scales segment targets to the episode budget", async () => {
    const { normalizeOutlineTargets } = await import("./podcast-script");
    const outline = { title: "t", description: "", coverPrompt: "", genres: [], motif: "", throughLine: "", hook: "", reveals: [], digressions: [], segments: [
      { title: "a", goal: "", keyFacts: [], targetWords: 1000, tension: "" },
      { title: "b", goal: "", keyFacts: [], targetWords: 3000, tension: "" },
    ] } as unknown as Parameters<typeof normalizeOutlineTargets>[0];
    const scaled = normalizeOutlineTargets(outline, 2000);
    expect(scaled.segments.map((s) => s.targetWords)).toEqual([500, 1500]);
  });

  test("lengthNotes flags only segments more than 20% over target", async () => {
    const { lengthNotes } = await import("./podcast-script");
    const words = (n: number) => Array.from({ length: n }, () => "wort").join(" ");
    const outline = { segments: [{ targetWords: 100 }, { targetWords: 100 }] } as unknown as Parameters<typeof lengthNotes>[1];
    const notes = lengthNotes(
      [
        { title: "ok", turns: [{ speaker: "A", text: words(110) }] },
        { title: "long", turns: [{ speaker: "A", text: words(90) }, { speaker: "B", text: words(60) }] },
      ],
      outline,
    );
    expect(notes.map((n) => n.segmentIndex)).toEqual([1]);
    expect(notes[0]?.note).toContain("150 words against a target of 100");
  });
});

describe("metadata pass — partial reply", () => {
  test("a blank field keeps the outline's draft for that field", async () => {
    const { parseEpisodeMetadata } = await import("./podcast-script");
    const parsed = parseEpisodeMetadata('{"description":"Neu.","chapters":[{"segment":0,"title":"Kalt"}]}', 2);
    expect(parsed.title).toBe("");
    expect(parsed.description).toBe("Neu.");
    expect(parsed.chapters).toEqual([{ segmentIndex: 0, title: "Kalt" }]);
    expect(parsed.topics).toEqual([]);
  });

  test("topics are trimmed and blanks dropped", async () => {
    const { parseEpisodeMetadata } = await import("./podcast-script");
    const parsed = parseEpisodeMetadata('{"topics":["  Maut ","", "Vignette", 7]}', 1);
    expect(parsed.topics).toEqual(["Maut", "Vignette"]);
  });
});
