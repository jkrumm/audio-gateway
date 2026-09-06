/**
 * Hermetic tests for the editorial room. Stubs globalThis.fetch — no network,
 * no creds. See replicate-tts.test.ts for the shared env baseline.
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

const { decideEpisodeBrief, defaultEpisodeBrief, parseEpisodeBrief, renderHistoryTable } = await import("./podcast-editorial");
const { EMPTY_DOSSIER } = await import("./podcast-types");
type EditorialInput = import("./podcast-editorial").EditorialInput;
type EpisodeSummary = import("./podcast-types").EpisodeSummary;
type PodcastHost = import("./podcast-script").PodcastHost;

type FetchImpl = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

function setFetch(impl: FetchImpl): void {
  (globalThis as unknown as { fetch: FetchImpl }).fetch = mock(impl);
}

afterEach(() => {
  delete (globalThis as unknown as { fetch?: FetchImpl }).fetch;
});

function chatCompletion(content: string, status = 200): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const HOSTS: [PodcastHost, PodcastHost] = [
  { id: "A", name: "Jonas", voice: "Rachel" },
  { id: "B", name: "Lena", voice: "Roger" },
];

const INPUT: EditorialInput = {
  dossier: EMPTY_DOSSIER,
  source: "Die Maut in Österreich kostet zwölf Euro fünfzig für zehn Tage.",
  brief: "Für jemanden, der im August fährt.",
  language: "de",
  minutes: 20,
  pinMinutes: false,
  bounds: { minMinutes: 3, maxMinutes: 60 },
  series: "Brain Sonderausgabe",
  hosts: HOSTS,
  history: [],
  showBible: "Jonas ist ruhig und präzise. Lena rechnet nach.",
};

const FULL_BRIEF_JSON = JSON.stringify({
  format: "Kurzbriefing",
  rationale: "Das Material ist technisch und kurz.",
  minutes: 7,
  segments: 2,
  roles: { A: "führt durch die Rechnung", B: "hakt bei den Zahlen nach" },
  tone: "sachlich, dicht",
  humor: "none",
  opening: "Direkt rein, kein Cold Open.",
  closing: "Aufhören, wenn die Rechnung steht.",
  rhythm: "Lange Turns, wenige Wechsel.",
  devices: [],
  avoid: ["Zahl, dann 'Warte —'"],
  glossary_policy: "Erst was es IST, dann wie es HEISST.",
});

describe("renderHistoryTable", () => {
  test("renders one row per episode with the axes the editor varies on", () => {
    const history: EpisodeSummary[] = [
      {
        id: "job-1",
        createdAt: "2026-09-02T10:00:00.000Z",
        title: "Obermenzing",
        description: "d",
        profile: {
          format: "Erklärstück",
          lead: "A",
          humor: "natural",
          opening: "Zahl, dann 'Warte —'",
          minutes: 22,
          durationSeconds: 1500,
          topics: ["Maut"],
          segmentCount: 5,
          toolCalls: 0,
          researchCalls: 0,
        },
      },
    ];
    const table = renderHistoryTable(history);
    expect(table).toContain("| Date | Title | Format | Lead | Humor | Opening | Minutes |");
    expect(table).toContain("|-|-|-|-|-|-|-|");
    expect(table).toContain("| 2026-09-02 | Obermenzing | Erklärstück | A | natural | Zahl, dann 'Warte —' | 22 |");
  });

  test("an episode from before the profile existed still gets a row", () => {
    const table = renderHistoryTable([{ id: "old", createdAt: "2026-08-01T00:00:00.000Z", title: "Alt", description: "", profile: null }]);
    expect(table).toContain("| 2026-08-01 | Alt | — | — | — | — | — |");
  });

  test("escapes a pipe in a title so the table survives it", () => {
    const table = renderHistoryTable([{ id: "x", createdAt: "2026-08-01T00:00:00.000Z", title: "A | B", description: "", profile: null }]);
    expect(table).toContain("A \\| B");
  });

  test("says so when there is no history", () => {
    expect(renderHistoryTable([])).toBe("(no previous episodes)");
  });
});

describe("defaultEpisodeBrief", () => {
  test("is a neutral conversation at the requested length — never the old formula", () => {
    const brief = defaultEpisodeBrief({ minutes: 20, language: "de", hosts: HOSTS });
    expect(brief.minutes).toBe(20);
    expect(brief.segments).toBe(5); // planSegmentCount(20)
    expect(brief.humor).toBe("sparse");
    expect(brief.devices).toEqual([]);
    expect(brief.avoid).toEqual([]);
    expect(brief.opening).toContain("Straight in with the topic");
    expect(brief.roles.A).toContain("Jonas");
    expect(brief.roles.B).toContain("Lena");
    expect(brief.format).toBe("Gespräch");
    expect(defaultEpisodeBrief({ minutes: 20, language: "en", hosts: HOSTS }).format).toBe("Conversation");
  });
});

describe("parseEpisodeBrief", () => {
  test("parses a full reply", () => {
    const brief = parseEpisodeBrief(FULL_BRIEF_JSON, INPUT);
    expect(brief.format).toBe("Kurzbriefing");
    expect(brief.minutes).toBe(7);
    expect(brief.segments).toBe(2);
    expect(brief.humor).toBe("none");
    expect(brief.roles).toEqual({ A: "führt durch die Rechnung", B: "hakt bei den Zahlen nach" });
    expect(brief.avoid).toEqual(["Zahl, dann 'Warte —'"]);
    expect(brief.glossaryPolicy).toBe("Erst was es IST, dann wie es HEISST.");
  });

  test("tolerates fences and leading prose, and accepts camelCase glossaryPolicy", () => {
    const raw = `Here is the brief:\n\`\`\`json\n${JSON.stringify({ format: "Interview", glossaryPolicy: "Langsam einführen." })}\n\`\`\``;
    const brief = parseEpisodeBrief(raw, INPUT);
    expect(brief.format).toBe("Interview");
    expect(brief.glossaryPolicy).toBe("Langsam einführen.");
  });

  test("clamps minutes to the bounds and segments to 1..9", () => {
    const long = parseEpisodeBrief(JSON.stringify({ minutes: 900, segments: 40 }), INPUT);
    expect(long.minutes).toBe(60);
    expect(long.segments).toBe(9);
    const short = parseEpisodeBrief(JSON.stringify({ minutes: 1, segments: 0 }), INPUT);
    expect(short.minutes).toBe(3);
    expect(short.segments).toBe(1);
  });

  test("a pinned request wins over whatever the editor argued for", () => {
    const brief = parseEpisodeBrief(JSON.stringify({ minutes: 5 }), { ...INPUT, pinMinutes: true });
    expect(brief.minutes).toBe(20);
  });

  test("a missing segments field is recomputed against the brief's OWN minutes, not the requested minutes", () => {
    // Requested (INPUT.minutes) is 20 -> planSegmentCount(20) would be 5, the
    // old buggy fallback. The editor argues for 50 minutes instead; segments
    // must follow THAT number: planSegmentCount(50) = 9.
    const brief = parseEpisodeBrief(JSON.stringify({ minutes: 50 }), INPUT);
    expect(brief.minutes).toBe(50);
    expect(brief.segments).toBe(9);
  });

  test("a missing segments field on a PINNED request is recomputed against the pinned minutes", () => {
    // The editor's own (ignored) minutes must not leak into the segment count either.
    const brief = parseEpisodeBrief(JSON.stringify({ minutes: 999 }), { ...INPUT, minutes: 8, pinMinutes: true });
    expect(brief.minutes).toBe(8);
    expect(brief.segments).toBe(3); // planSegmentCount(8)
  });

  test("an unknown or missing humor level falls back to sparse", () => {
    expect(parseEpisodeBrief(JSON.stringify({ humor: "hilarious" }), INPUT).humor).toBe("sparse");
    expect(parseEpisodeBrief("{}", INPUT).humor).toBe("sparse");
    expect(parseEpisodeBrief(JSON.stringify({ humor: "None" }), INPUT).humor).toBe("none");
  });

  test("missing fields fall back to the neutral default, not to the old formula", () => {
    const brief = parseEpisodeBrief("{}", INPUT);
    const fallback = defaultEpisodeBrief(INPUT);
    expect(brief.minutes).toBe(20);
    expect(brief.segments).toBe(fallback.segments);
    expect(brief.opening).toBe(fallback.opening);
    expect(brief.roles).toEqual(fallback.roles);
    expect(brief.devices).toEqual([]);
    expect(brief.rationale).toBe("");
  });

  test("drops non-string and blank entries from devices/avoid", () => {
    const brief = parseEpisodeBrief(JSON.stringify({ devices: [" ein Motiv ", "", 7, null], avoid: "not an array" }), INPUT);
    expect(brief.devices).toEqual(["ein Motiv"]);
    expect(brief.avoid).toEqual([]);
  });

  test("throws only when there is no JSON object at all", () => {
    expect(() => parseEpisodeBrief("I'd rather not.", INPUT)).toThrow();
  });
});

describe("decideEpisodeBrief", () => {
  test("sends the show bible, the history table and the source head, and returns the parsed brief", async () => {
    let systemPrompt = "";
    let userContent = "";
    let model = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { model: string; messages: Array<{ content: string }> };
      model = body.model;
      systemPrompt = body.messages[0]?.content ?? "";
      userContent = body.messages[1]?.content ?? "";
      return chatCompletion(FULL_BRIEF_JSON);
    });

    const brief = await decideEpisodeBrief(
      {
        ...INPUT,
        history: [
          {
            id: "job-1",
            createdAt: "2026-09-02T10:00:00.000Z",
            title: "Obermenzing",
            description: "d",
            profile: {
              format: "Erklärstück",
              lead: "A",
              humor: "natural",
              opening: "Zahl, dann 'Warte —'",
              minutes: 22,
              durationSeconds: null,
              topics: [],
              segmentCount: 5,
              toolCalls: 0,
              researchCalls: 0,
            },
          },
        ],
      },
      { model: "editor-model" },
    );

    expect(model).toBe("editor-model");
    expect(brief.format).toBe("Kurzbriefing");
    expect(brief.minutes).toBe(7);

    expect(systemPrompt).toContain('You are the editor of "Brain Sonderausgabe"');
    expect(systemPrompt).toContain("You do not write the episode");
    expect(systemPrompt).toContain("Do not invent drama");
    expect(systemPrompt).toContain("Five minutes is a valid episode.");
    expect(systemPrompt).toContain("Hosts: A = Jonas, B = Lena");
    expect(systemPrompt).toContain("The requested 20 minutes are a hint");
    expect(systemPrompt).toContain("between 3 and 60 minutes");

    expect(userContent).toContain("SHOW BIBLE");
    expect(userContent).toContain("Jonas ist ruhig und präzise.");
    expect(userContent).toContain("| 2026-09-02 | Obermenzing | Erklärstück | A | natural |");
    expect(userContent).toContain("LISTENER BRIEF");
    expect(userContent).toContain("Die Maut in Österreich kostet zwölf Euro fünfzig");
  });

  test("a pinned length is stated as pinned in the prompt", async () => {
    let systemPrompt = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      systemPrompt = body.messages[0]?.content ?? "";
      return chatCompletion(FULL_BRIEF_JSON);
    });
    const brief = await decideEpisodeBrief({ ...INPUT, pinMinutes: true }, { model: "editor-model" });
    expect(systemPrompt).toContain("The length is PINNED at 20 minutes");
    expect(brief.minutes).toBe(20);
  });

  test("only the source head reaches the prompt", async () => {
    let userContent = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      userContent = body.messages[1]?.content ?? "";
      return chatCompletion(FULL_BRIEF_JSON);
    });
    await decideEpisodeBrief({ ...INPUT, source: `${"x".repeat(6000)}NEEDLE` }, { model: "editor-model" });
    expect(userContent).not.toContain("NEEDLE");
  });

  test("the dossier's summary, glossary, prior coverage and open questions are in the user content; empty sections are omitted", async () => {
    let userContent = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      userContent = body.messages[1]?.content ?? "";
      return chatCompletion(FULL_BRIEF_JSON);
    });

    await decideEpisodeBrief(
      {
        ...INPUT,
        dossier: {
          summary: "Es geht um die Maut.",
          additions: [],
          glossary: [{ term: "ASFINAG", plain: "die Firma hinter Österreichs Autobahnen" }],
          priorCoverage: [{ episodeId: "e1", title: "Folge eins", covered: "die Brenner-Route" }],
          openQuestions: ["Gilt das auch für den Anhänger?"],
          toolCalls: [],
        },
      },
      { model: "editor-model" },
    );

    expect(userContent).toContain("Es geht um die Maut.");
    expect(userContent).toContain("ASFINAG — die Firma hinter Österreichs Autobahnen");
    expect(userContent).toContain("Folge eins: die Brenner-Route");
    expect(userContent).toContain("Gilt das auch für den Anhänger?");

    let bare = "";
    setFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages: Array<{ content: string }> };
      bare = body.messages[1]?.content ?? "";
      return chatCompletion(FULL_BRIEF_JSON);
    });
    await decideEpisodeBrief(INPUT, { model: "editor-model" });
    expect(bare).not.toContain("GLOSSARY");
    expect(bare).not.toContain("PRIOR COVERAGE");
    expect(bare).not.toContain("OPEN QUESTIONS");
    expect(bare).toContain("(no previous episodes)");
  });

  test("retries an unparseable reply once, then succeeds", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return calls === 1 ? chatCompletion("I'd rather not.") : chatCompletion(FULL_BRIEF_JSON);
    });
    const brief = await decideEpisodeBrief(INPUT, { model: "editor-model" });
    expect(calls).toBe(2);
    expect(brief.format).toBe("Kurzbriefing");
  });

  test("falls back to the neutral default brief when the reply never parses", async () => {
    let calls = 0;
    setFetch(async () => {
      calls++;
      return chatCompletion("no json here");
    });
    const brief = await decideEpisodeBrief(INPUT, { model: "editor-model" });
    expect(calls).toBe(2);
    expect(brief).toEqual(defaultEpisodeBrief(INPUT));
  });

  test("falls back to the neutral default brief when the upstream errors, and never throws", async () => {
    setFetch(async () => chatCompletion("upstream exploded", 500));
    const brief = await decideEpisodeBrief(INPUT, { model: "editor-model" });
    expect(brief).toEqual(defaultEpisodeBrief(INPUT));
  });
});
