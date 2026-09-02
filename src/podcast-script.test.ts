/**
 * Hermetic tests for the podcast script writer. Stubs globalThis.fetch — no
 * network, no creds. See replicate-tts.test.ts for the shared env baseline.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

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
  V3_PODCAST_TAGS,
} = await import("./podcast-script");

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

describe("planSegmentCount", () => {
  test("clamps to the 3..9 range around ~4 minutes per segment", () => {
    expect(planSegmentCount(1)).toBe(3);
    expect(planSegmentCount(12)).toBe(3);
    expect(planSegmentCount(20)).toBe(5);
    expect(planSegmentCount(100)).toBe(9);
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

const BASE_REQUEST = {
  source: "Der Van kostet dreihundert Euro pro Nacht.",
  brief: "Für einen Freund, der einen Roadtrip plant.",
  language: "de" as const,
  minutes: 12,
  hosts: HOSTS,
  series: "Roadtrip Radio",
};

describe("writePodcastScript", () => {
  test("review: false writes an outline then every segment in parallel, preserving order and summing wordCount, with no review/revision calls", async () => {
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

    const script = await writePodcastScript(BASE_REQUEST, { model: "claude-sonnet-5", concurrency: 2, review: false });

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

  test("review: true runs outline, segments, three parallel reviews, then revises only the segments with notes", async () => {
    const calls: string[] = [];
    let reviseCalls = 0;

    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";

      if (systemPrompt.includes("You are writing the OUTLINE")) {
        calls.push("outline");
        return outlineResponse();
      }

      if (systemPrompt.startsWith("You are the DRAMATURGE")) {
        calls.push("review-dramaturge");
        return chatCompletion(
          JSON.stringify({
            notes: [{ segment: 0, turn: 0, note: "Open with the hook, not a summary." }],
            verdict: "Needs one fix in the cold open.",
          }),
        );
      }
      if (systemPrompt.startsWith("You are the CONVERSATION COACH")) {
        calls.push("review-coach");
        return chatCompletion(JSON.stringify({ notes: [], verdict: "Sounds natural." }));
      }
      if (systemPrompt.startsWith("You are the FACT & SPEECH EDITOR")) {
        calls.push("review-fact-editor");
        return chatCompletion(
          JSON.stringify({
            notes: [{ segment: null, turn: null, note: "Spell out all currency amounts." }],
            verdict: "One episode-wide fix needed.",
          }),
        );
      }

      if (systemPrompt.includes("You are REVISING ONE SEGMENT")) {
        calls.push("revise");
        reviseCalls++;
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
      calls.push("segment");
      const index = Number(match[1]) - 1;
      return segmentResponse(index);
    });

    const script = await writePodcastScript(BASE_REQUEST, { model: "claude-sonnet-5", concurrency: 2, review: true });

    // outline, 3 segments, 3 reviews, 1 revision (only segment 0 had a targeted note).
    expect(calls.filter((c) => c === "outline")).toHaveLength(1);
    expect(calls.filter((c) => c === "segment")).toHaveLength(3);
    expect(calls.filter((c) => c.startsWith("review-"))).toHaveLength(3);
    expect(calls.filter((c) => c === "revise")).toHaveLength(1);
    expect(reviseCalls).toBe(1);

    // Revision happened strictly after all reviews, which happened after all segments.
    const lastSegmentIdx = calls.lastIndexOf("segment");
    const firstReviewIdx = calls.findIndex((c) => c.startsWith("review-"));
    const reviseIdx = calls.indexOf("revise");
    expect(firstReviewIdx).toBeGreaterThan(lastSegmentIdx);
    expect(reviseIdx).toBeGreaterThan(calls.lastIndexOf("review-dramaturge"));
    expect(reviseIdx).toBeGreaterThan(calls.lastIndexOf("review-coach"));
    expect(reviseIdx).toBeGreaterThan(calls.lastIndexOf("review-fact-editor"));

    // Segment 0 carries the revised turns; segments 1 and 2 are untouched.
    expect(script.segments[0]?.turns[0]?.text).toContain("Revised Cold open");
    expect(script.segments[1]?.turns[0]?.text).toBe("Segment 1 Zeile eins von Lena.");
    expect(script.segments[2]?.turns[0]?.text).toBe("Segment 2 Zeile eins von Lena.");
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
