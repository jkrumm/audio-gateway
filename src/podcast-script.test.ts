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

describe("writePodcastScript", () => {
  test("writes an outline then every segment in parallel, preserving order and summing wordCount", async () => {
    const outlineSegments = [
      { title: "Cold open", goal: "hook the listener", key_facts: ["fact A"], target_words: 100, tension: "will it work" },
      { title: "Middle", goal: "explain the plan", key_facts: ["fact B"], target_words: 100, tension: "is it enough time" },
      { title: "Wrap-up", goal: "close the episode", key_facts: ["fact C"], target_words: 100, tension: "what's left open" },
    ];

    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      const systemPrompt = body.messages[0]?.content ?? "";
      if (systemPrompt.includes("You are writing the OUTLINE")) {
        return chatCompletion(
          JSON.stringify({
            title: "Der Roadtrip-Plan",
            description: "Eine kurze Beschreibung.",
            cover_prompt: "A camper van on a coastal road at golden hour",
            genres: ["Travel"],
            segments: outlineSegments,
          }),
        );
      }
      const match = /You are writing ONE SEGMENT \((\d) of (\d)\)/.exec(systemPrompt);
      if (!match) throw new Error(`unexpected prompt: ${systemPrompt.slice(0, 100)}`);
      const index = Number(match[1]) - 1;
      return chatCompletion(
        JSON.stringify({
          turns: [
            { speaker: "A", text: `Segment ${index} Zeile eins von Lena.` },
            { speaker: "B", text: `Segment ${index} Zeile zwei von Marco.` },
          ],
        }),
      );
    });

    const script = await writePodcastScript(
      {
        source: "Der Van kostet dreihundert Euro pro Nacht.",
        brief: "Für einen Freund, der einen Roadtrip plant.",
        language: "de",
        minutes: 12,
        hosts: HOSTS,
        series: "Roadtrip Radio",
      },
      { model: "claude-sonnet-5", concurrency: 2 },
    );

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
