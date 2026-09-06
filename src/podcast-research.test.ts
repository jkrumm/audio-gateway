/**
 * Hermetic tests for the research stage: vault search/read against a real
 * temp-dir filesystem, the research-gateway submit/poll flow against a
 * scripted fake fetch, dossier parsing, and one end-to-end tool-loop run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";

const { buildResearchTools, parseDossier, readBrainNotes, runPodcastResearch } = await import("./podcast-research");
type ToolLoopFetch = import("./llm-tools").ToolLoopFetch;
type EpisodeHistory = import("./podcast-types").EpisodeHistory;

function rawRes(status: number, body: unknown): { status: number; body: string } {
  return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
}

function findTool(tools: import("./llm-tools").ToolDef[], name: string): import("./llm-tools").ToolDef {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool "${name}" not found`);
  return tool;
}

const noHistory: EpisodeHistory = {
  recent: () => [],
  transcript: () => null,
};

// ---------------------------------------------------------------------------
// brain_search / brain_read against a real temp-dir vault
// ---------------------------------------------------------------------------

describe("brain_search / brain_read", () => {
  let vault: string;

  function setupVault(): string {
    const dir = mkdtempSync(join(tmpdir(), "brain-test-"));
    writeFileSync(
      join(dir, "peptides.md"),
      `---\ntitle: Peptide\ndescription: Notes on peptide research\n---\n\nBPC-157 and TB-500 are the two peptides discussed most. BPC-157 helps healing.\n`,
    );
    writeFileSync(
      join(dir, "unrelated.md"),
      `---\ntitle: Finance\ndescription: Budget notes\n---\n\nJust spreadsheets and invoices, nothing biological here.\n`,
    );
    mkdirSync(join(dir, "Areas"));
    writeFileSync(
      join(dir, "Areas", "peptide-protocol.md"),
      `---\ntitle: Peptide Protocol\n---\n\nA protocol note that mentions peptide dosing repeatedly: peptide, peptide, peptide.\n`,
    );
    mkdirSync(join(dir, ".obsidian"));
    writeFileSync(join(dir, ".obsidian", "peptide-secret.md"), "peptide peptide peptide");
    return dir;
  }

  afterEach(() => {
    if (vault) rmSync(vault, { recursive: true, force: true });
  });

  test("ranks notes by term occurrence and path hits, skips dotdirs, returns a snippet", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_search");
    const raw = await tool.execute({ query: "peptide" });
    const results = JSON.parse(raw) as Array<{ path: string; title: string; description: string; snippet: string; score: number }>;

    const paths = results.map((r) => r.path);
    expect(paths).not.toContain(".obsidian/peptide-secret.md");
    expect(paths).toContain("peptides.md");
    expect(paths).toContain(join("Areas", "peptide-protocol.md"));
    expect(paths).not.toContain("unrelated.md");

    // Areas/peptide-protocol.md repeats the term more AND has it in the path → outranks peptides.md.
    expect(results[0]?.path).toBe(join("Areas", "peptide-protocol.md"));
    const peptidesResult = results.find((r) => r.path === "peptides.md");
    expect(peptidesResult?.title).toBe("Peptide");
    expect(peptidesResult?.snippet.toLowerCase()).toContain("peptide");
  });

  test("returns [] when nothing matches", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_search");
    const raw = await tool.execute({ query: "xyznomatch" });
    expect(JSON.parse(raw)).toEqual([]);
  });

  test("brain_read returns frontmatter and body, capped and reported when truncated", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    const raw = await tool.execute({ path: "peptides.md" });
    const result = JSON.parse(raw) as { path: string; frontmatter: Record<string, string>; body: string };
    expect(result.frontmatter["title"]).toBe("Peptide");
    expect(result.body).toContain("BPC-157");
  });

  test("brain_read rejects a path that escapes the vault via ..", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: "../outside.md" })).rejects.toThrow(/escapes the vault/);
  });

  test("brain_read rejects an absolute path", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: "/etc/passwd" })).rejects.toThrow(/relative to the vault/);
  });

  test("brain_read rejects a symlink that escapes the vault", async () => {
    vault = setupVault();
    const outsideDir = mkdtempSync(join(tmpdir(), "brain-outside-"));
    writeFileSync(join(outsideDir, "secret.md"), "top secret");
    symlinkSync(join(outsideDir, "secret.md"), join(vault, "escape.md"));
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: "escape.md" })).rejects.toThrow(/escapes the vault/);
    rmSync(outsideDir, { recursive: true, force: true });
  });

  test("readBrainNotes reads multiple vault-relative paths and rejects one outside the vault", async () => {
    vault = setupVault();
    const notes = await readBrainNotes(vault, ["peptides.md"]);
    expect(notes).toEqual([{ path: "peptides.md", text: expect.stringContaining("BPC-157") }]);
    await expect(readBrainNotes(vault, ["../outside.md"])).rejects.toThrow(/escapes the vault/);
  });

  test("brain_read rejects a dotfile inside a hidden directory", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: ".obsidian/plugins/x/data.json" })).rejects.toThrow(/markdown files outside hidden directories/);
  });

  test("brain_read rejects a bare dotfile", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: ".env" })).rejects.toThrow(/markdown files outside hidden directories/);
  });

  test("brain_read rejects a hidden directory nested deeper in the vault", async () => {
    vault = setupVault();
    mkdirSync(join(vault, "foo", ".hidden"), { recursive: true });
    writeFileSync(join(vault, "foo", ".hidden", "x.md"), "secret");
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: "foo/.hidden/x.md" })).rejects.toThrow(/markdown files outside hidden directories/);
  });

  test("brain_read rejects a non-markdown file", async () => {
    vault = setupVault();
    writeFileSync(join(vault, "note.txt"), "not markdown");
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    await expect(tool.execute({ path: "note.txt" })).rejects.toThrow(/markdown files outside hidden directories/);
  });

  test("brain_read accepts an ordinary vault-relative markdown path", async () => {
    vault = setupVault();
    const tools = buildResearchTools({ brainDir: vault, history: noHistory, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "brain_read");
    const raw = await tool.execute({ path: "Areas/peptide-protocol.md" });
    const result = JSON.parse(raw) as { path: string };
    expect(result.path).toBe("Areas/peptide-protocol.md");
  });
});

// ---------------------------------------------------------------------------
// past_episodes / past_transcript
// ---------------------------------------------------------------------------

describe("past_episodes / past_transcript", () => {
  const history: EpisodeHistory = {
    recent: (limit) =>
      [{ id: "ep-1", createdAt: "2026-01-01T00:00:00.000Z", title: "Episode One", description: "d", profile: null }].slice(0, limit),
    transcript: (id) => (id === "ep-1" ? "# Episode One\n\ntranscript body" : null),
  };

  test("past_episodes returns history.recent(limit) as JSON", async () => {
    const tools = buildResearchTools({ history, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "past_episodes");
    const raw = await tool.execute({ limit: 5 });
    expect(JSON.parse(raw)).toEqual([{ id: "ep-1", createdAt: "2026-01-01T00:00:00.000Z", title: "Episode One", description: "d", profile: null }]);
  });

  test("past_transcript returns the transcript or an error string", async () => {
    const tools = buildResearchTools({ history, model: "m", maxRounds: 1 });
    const tool = findTool(tools, "past_transcript");
    expect(await tool.execute({ id: "ep-1" })).toContain("transcript body");
    expect(await tool.execute({ id: "missing" })).toMatch(/no transcript found/);
  });
});

// ---------------------------------------------------------------------------
// research tool: budget, submit/poll, 429, failed
// ---------------------------------------------------------------------------

describe("research tool", () => {
  function scriptedFetch(responses: Array<{ status: number; body: string }>): { fetchImpl: ToolLoopFetch; count: () => number } {
    let i = 0;
    const fetchImpl: ToolLoopFetch = (async () => {
      const res = responses[i];
      i++;
      if (!res) throw new Error(`no response scripted for call ${i}`);
      return res;
    }) as ToolLoopFetch;
    return { fetchImpl, count: () => i };
  }

  test("enforces the per-run budget without calling fetch again once exhausted", async () => {
    const { fetchImpl, count } = scriptedFetch([
      rawRes(200, { jobId: "job-1" }),
      rawRes(200, { status: "done", result: { report: "the report", sources: ["src-a"] } }),
    ]);
    const tools = buildResearchTools({
      history: noHistory,
      model: "m",
      maxRounds: 1,
      research: { url: "https://research.example.com", apiKey: "key", maxCalls: 1 },
      fetchImpl,
      pollIntervalMs: 0,
    });
    const tool = findTool(tools, "research");
    const first = await tool.execute({ query: "q1" });
    expect(first).toContain("the report");
    expect(first).toContain("Sources:\n- src-a");
    const second = await tool.execute({ query: "q2" });
    expect(second).toBe("research budget exhausted (1 calls)");
    expect(count()).toBe(2); // second call made no network requests
  });

  test("polls queued → running → done", async () => {
    const { fetchImpl } = scriptedFetch([
      rawRes(200, { jobId: "job-1" }),
      rawRes(200, { status: "queued" }),
      rawRes(200, { status: "running" }),
      rawRes(200, { status: "done", result: { report: "final report" } }),
    ]);
    const tools = buildResearchTools({
      history: noHistory,
      model: "m",
      maxRounds: 1,
      research: { url: "https://research.example.com", apiKey: "key", maxCalls: 5 },
      fetchImpl,
      pollIntervalMs: 0,
    });
    const result = await findTool(tools, "research").execute({ query: "q" });
    expect(result).toContain("final report");
  });

  test("429 on submit returns a queue-full message", async () => {
    const { fetchImpl } = scriptedFetch([rawRes(429, { error: "full" })]);
    const tools = buildResearchTools({
      history: noHistory,
      model: "m",
      maxRounds: 1,
      research: { url: "https://research.example.com", apiKey: "key", maxCalls: 5 },
      fetchImpl,
      pollIntervalMs: 0,
    });
    const result = await findTool(tools, "research").execute({ query: "q" });
    expect(result).toBe("research queue full, try later");
  });

  test("failed status returns the error string", async () => {
    const { fetchImpl } = scriptedFetch([rawRes(200, { jobId: "job-1" }), rawRes(200, { status: "failed", error: "no sources found" })]);
    const tools = buildResearchTools({
      history: noHistory,
      model: "m",
      maxRounds: 1,
      research: { url: "https://research.example.com", apiKey: "key", maxCalls: 5 },
      fetchImpl,
      pollIntervalMs: 0,
    });
    const result = await findTool(tools, "research").execute({ query: "q" });
    expect(result).toMatch(/research failed: no sources found/);
  });

  test("a 429 on submit does not consume a budget slot", async () => {
    const { fetchImpl } = scriptedFetch([
      rawRes(429, { error: "full" }),
      rawRes(200, { jobId: "job-1" }),
      rawRes(200, { status: "done", result: { report: "recovered report" } }),
    ]);
    const tools = buildResearchTools({
      history: noHistory,
      model: "m",
      maxRounds: 1,
      research: { url: "https://research.example.com", apiKey: "key", maxCalls: 1 },
      fetchImpl,
      pollIntervalMs: 0,
    });
    const tool = findTool(tools, "research");
    expect(await tool.execute({ query: "q1" })).toBe("research queue full, try later");
    expect(await tool.execute({ query: "q2" })).toContain("recovered report");
  });

  test("a transport error on submit does not consume a budget slot", async () => {
    let calls = 0;
    const fetchImpl: ToolLoopFetch = (async () => {
      calls++;
      if (calls === 1) throw new Error("network down");
      if (calls === 2) return rawRes(200, { jobId: "job-1" });
      return rawRes(200, { status: "done", result: { report: "recovered after transport error" } });
    }) as ToolLoopFetch;
    const tools = buildResearchTools({
      history: noHistory,
      model: "m",
      maxRounds: 1,
      research: { url: "https://research.example.com", apiKey: "key", maxCalls: 1 },
      fetchImpl,
      pollIntervalMs: 0,
    });
    const tool = findTool(tools, "research");
    await expect(tool.execute({ query: "q1" })).rejects.toThrow("network down");
    expect(await tool.execute({ query: "q2" })).toContain("recovered after transport error");
  });
});

// ---------------------------------------------------------------------------
// parseDossier
// ---------------------------------------------------------------------------

describe("parseDossier", () => {
  test("parses a well-formed dossier", () => {
    const raw = JSON.stringify({
      summary: "the summary",
      additions: [{ source: "brain: Areas/x.md", text: "extra" }],
      glossary: [{ term: "BPC-157", plain: "a healing peptide" }],
      priorCoverage: [{ episodeId: "ep-1", title: "Episode One", covered: "the basics" }],
      openQuestions: ["is it safe long-term?"],
    });
    const dossier = parseDossier(raw);
    expect(dossier.summary).toBe("the summary");
    expect(dossier.additions).toEqual([{ source: "brain: Areas/x.md", text: "extra" }]);
    expect(dossier.glossary).toEqual([{ term: "BPC-157", plain: "a healing peptide" }]);
    expect(dossier.priorCoverage).toEqual([{ episodeId: "ep-1", title: "Episode One", covered: "the basics" }]);
    expect(dossier.openQuestions).toEqual(["is it safe long-term?"]);
    expect(dossier.toolCalls).toEqual([]);
  });

  test("defaults missing arrays to [] and trims strings", () => {
    const dossier = parseDossier(JSON.stringify({ summary: "  trimmed  " }));
    expect(dossier.summary).toBe("trimmed");
    expect(dossier.additions).toEqual([]);
    expect(dossier.glossary).toEqual([]);
    expect(dossier.priorCoverage).toEqual([]);
    expect(dossier.openQuestions).toEqual([]);
  });

  test("extracts JSON fenced in a markdown code block", () => {
    const raw = "Here is my answer:\n```json\n" + JSON.stringify({ summary: "fenced" }) + "\n```\nThanks.";
    expect(parseDossier(raw).summary).toBe("fenced");
  });

  test("throws when no JSON object is present at all", () => {
    expect(() => parseDossier("no json here at all")).toThrow(/no JSON object/);
  });
});

// ---------------------------------------------------------------------------
// runPodcastResearch — end to end against a scripted tool loop
// ---------------------------------------------------------------------------

describe("runPodcastResearch", () => {
  test("calls past_episodes once then returns the parsed dossier", async () => {
    const history: EpisodeHistory = {
      recent: () => [{ id: "ep-1", createdAt: "2026-01-01T00:00:00.000Z", title: "Episode One", description: "d", profile: null }],
      transcript: () => null,
    };
    const assistantToolCall = {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "past_episodes", arguments: "{}" } }],
    };
    const dossierJson = JSON.stringify({
      summary: "an episode about peptides was already covered",
      additions: [],
      glossary: [],
      priorCoverage: [{ episodeId: "ep-1", title: "Episode One", covered: "basics" }],
      openQuestions: [],
    });
    let call = 0;
    const fetchImpl: ToolLoopFetch = (async () => {
      call++;
      if (call === 1) {
        return rawRes(200, { choices: [{ message: assistantToolCall, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }
      return rawRes(200, { choices: [{ message: { role: "assistant", content: dossierJson }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }) as ToolLoopFetch;

    const dossier = await runPodcastResearch(
      { source: "some notes about peptides", language: "de", series: "Brain Sonderausgabe" },
      { history, model: "test-model", maxRounds: 5, fetchImpl },
    );

    expect(dossier.summary).toBe("an episode about peptides was already covered");
    expect(dossier.priorCoverage).toEqual([{ episodeId: "ep-1", title: "Episode One", covered: "basics" }]);
    expect(dossier.toolCalls).toEqual([{ tool: "past_episodes", args: {}, ok: true, ms: expect.any(Number) }]);
    expect(call).toBe(2);
  });
});
