/**
 * Hermetic tests for the brain note renderer + best-effort git write. The
 * git test spins up a real temp-dir repo with a bare "remote" — no network.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["IU_API_KEY"] ??= "test-key";
process.env["IU_OPENAI_BASE_URL"] ??= "https://iu.example.com/openai/v1";
process.env["IU_GEMINI_BASE_URL"] ??= "https://iu.example.com/gemini/v1beta";
process.env["IU_REPLICATE_BASE_URL"] ??= "https://iu.example.com/replicate/v1";
process.env["USAGE_DB"] ??= ":memory:";

const { episodeNoteFilename, renderEpisodeNote, renderFolderNote, writeEpisodeBrainNote } = await import("./brain-note");
type EpisodeProfile = import("./podcast-types").EpisodeProfile;

const PROFILE: EpisodeProfile = {
  format: "Erklärstück",
  lead: "A",
  humor: "sparse",
  opening: "Direkt rein",
  minutes: 18,
  durationSeconds: 1080,
  topics: ["Peptide", "Recovery"],
  segmentCount: 4,
  toolCalls: 3,
  researchCalls: 1,
};

const TRANSCRIPT_MARKDOWN = [
  "# Test Episode",
  "",
  "A short description of the episode.",
  "",
  "## Segment One",
  "",
  "**Jonas:** Hallo und willkommen.",
  "**Lena:** Und los geht's.",
  "",
].join("\n");

function baseInput(overrides: Partial<Parameters<typeof renderEpisodeNote>[0]> = {}) {
  return {
    brainDir: "/tmp/does-not-matter",
    jobId: "job-123",
    title: "Test Episode",
    description: "A short description of the episode.",
    series: "Brain Sonderausgabe",
    createdAt: "2026-09-06T12:00:00.000Z",
    profile: PROFILE,
    transcriptMarkdown: TRANSCRIPT_MARKDOWN,
    absItemId: null as string | null,
    ...overrides,
  };
}

describe("renderEpisodeNote", () => {
  test("frontmatter carries the expected keys and the transcript heading/description are not duplicated", () => {
    const note = renderEpisodeNote(baseInput());
    expect(note).toContain("---\n");
    expect(note).toContain("title: Test Episode");
    expect(note).toContain("date: 2026-09-06");
    expect(note).toContain("tags: [podcast, brain-sonderausgabe]");
    expect(note).toContain("series: Brain Sonderausgabe");
    expect(note).toContain("format: Erklärstück");
    expect(note).toContain("lead: A");
    expect(note).toContain("humor: sparse");
    expect(note).toContain("minutes: 18");
    expect(note).toContain("topics:\n  - Peptide\n  - Recovery");
    expect(note).toContain("job: job-123");
    expect(note).not.toContain("abs:");

    expect(note).toContain("# Test Episode");
    expect(note).toContain("## Transkript");
    // The transcript's own leading "# Test Episode" + description line must not repeat inside the body.
    const afterTranskript = note.split("## Transkript")[1] ?? "";
    expect(afterTranskript).not.toContain("# Test Episode\n");
    expect(afterTranskript).toContain("## Segment One");
    expect(afterTranskript).toContain("**Jonas:** Hallo und willkommen.");
  });

  test("quotes a title containing a colon", () => {
    const note = renderEpisodeNote(baseInput({ title: 'Titel: Der Doppelpunkt' }));
    expect(note).toContain('title: "Titel: Der Doppelpunkt"');
  });

  test("includes abs when present", () => {
    const note = renderEpisodeNote(baseInput({ absItemId: "abs-item-1" }));
    expect(note).toContain("abs: abs-item-1");
  });

  test("writes topics: [] when there are none", () => {
    const note = renderEpisodeNote(baseInput({ profile: { ...PROFILE, topics: [] } }));
    expect(note).toContain("topics: []");
  });
});

describe("episodeNoteFilename", () => {
  test("formats as '<yyyy-mm-dd> <title>.md' and keeps umlauts", () => {
    expect(episodeNoteFilename("2026-09-06T12:00:00.000Z", "Erklärstück über Peptide")).toBe("2026-09-06 Erklärstück über Peptide.md");
  });

  test("strips filesystem-hostile characters", () => {
    const name = episodeNoteFilename("2026-01-01T00:00:00.000Z", 'A/B\\C:D*E?F"G<H>I|J');
    expect(name).toBe("2026-01-01 ABCDEFGHIJ.md");
  });

  test("collapses whitespace and caps at 80 chars", () => {
    const longTitle = `word ${"x".repeat(100)}`;
    const name = episodeNoteFilename("2026-01-01T00:00:00.000Z", `Multiple   \n\n  spaces   ${longTitle}`);
    expect(name.startsWith("2026-01-01 Multiple spaces word ")).toBe(true);
    expect(name.length).toBeLessThanOrEqual("2026-01-01 ".length + 80 + ".md".length);
  });
});

describe("renderFolderNote", () => {
  test("sorts entries newest first", () => {
    const note = renderFolderNote([
      { file: "2026-01-01 Old", title: "Old", date: "2026-01-01", format: "Kurzbriefing", minutes: 5 },
      { file: "2026-03-01 New", title: "New", date: "2026-03-01", format: "Erklärstück", minutes: 20 },
      { file: "2026-02-01 Mid", title: "Mid", date: "2026-02-01", format: "Interview", minutes: 10 },
    ]);
    const lines = note.split("\n").filter((l) => l.startsWith("- [["));
    expect(lines).toEqual([
      "- [[2026-03-01 New|New]] — 2026-03-01 · Erklärstück · 20 min",
      "- [[2026-02-01 Mid|Mid]] — 2026-02-01 · Interview · 10 min",
      "- [[2026-01-01 Old|Old]] — 2026-01-01 · Kurzbriefing · 5 min",
    ]);
  });

  test("renders an empty list without entries", () => {
    const note = renderFolderNote([]);
    expect(note).toContain("# Podcasts");
    expect(note.split("\n").some((l) => l.startsWith("- [["))).toBe(false);
  });
});

describe("writeEpisodeBrainNote", () => {
  function initVaultWithBareRemote(): { vault: string; remote: string } {
    const remote = mkdtempSync(join(tmpdir(), "brain-remote-"));
    Bun.spawnSync(["git", "init", "--bare", "-q"], { cwd: remote });

    const vault = mkdtempSync(join(tmpdir(), "brain-vault-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: vault });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: vault });
    Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: vault });
    Bun.spawnSync(["git", "commit", "--allow-empty", "-q", "-m", "init"], { cwd: vault });
    Bun.spawnSync(["git", "branch", "-M", "main"], { cwd: vault });
    Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: vault });
    Bun.spawnSync(["git", "push", "-q", "-u", "origin", "main"], { cwd: vault });
    return { vault, remote };
  }

  test("writes the note + folder note and commits + pushes to the remote", async () => {
    const { vault, remote } = initVaultWithBareRemote();
    try {
      const result = await writeEpisodeBrainNote(baseInput({ brainDir: vault }));

      expect(existsSync(result.path)).toBe(true);
      expect(result.path.endsWith("2026-09-06 Test Episode.md")).toBe(true);

      const folderNotePath = join(vault, "Areas", "Podcasts", "Podcasts.md");
      expect(existsSync(folderNotePath)).toBe(true);
      const folderNote = readFileSync(folderNotePath, "utf8");
      expect(folderNote).toContain("2026-09-06 Test Episode|Test Episode");

      expect(result.committed).toBe(true);
      expect(result.pushed).toBe(true);

      const log = Bun.spawnSync(["git", "log", "--oneline", "-1"], { cwd: vault });
      expect(log.stdout.toString()).toContain("podcast: Test Episode");

      const remoteLog = Bun.spawnSync(["git", "log", "--oneline", "-1", "main"], { cwd: remote });
      expect(remoteLog.stdout.toString()).toContain("podcast: Test Episode");
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });

  test("returns committed:false without throwing when the directory is not a git repo", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "brain-plain-"));
    try {
      const result = await writeEpisodeBrainNote(baseInput({ brainDir: plainDir }));
      expect(existsSync(result.path)).toBe(true);
      expect(result.committed).toBe(false);
      expect(result.pushed).toBe(false);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
