/**
 * Hermetic tests for the brain note renderer + best-effort git write. The
 * git test spins up a real temp-dir repo with a bare "remote" — no network.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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

const MULTI_PARAGRAPH_TRANSCRIPT_MARKDOWN = [
  "# Test Episode",
  "",
  "First paragraph of the description.",
  "",
  "Second paragraph of the description.",
  "",
  "## Segment One",
  "",
  "**Jonas:** Hallo und willkommen.",
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
    expect(note).toContain('title: "Test Episode"');
    expect(note).toContain("date: 2026-09-06");
    expect(note).toContain("tags: [podcast, brain-sonderausgabe]");
    expect(note).toContain('series: "Brain Sonderausgabe"');
    expect(note).toContain('format: "Erklärstück"');
    expect(note).toContain("lead: A");
    expect(note).toContain("humor: sparse");
    expect(note).toContain("minutes: 18");
    expect(note).toContain('topics:\n  - "Peptide"\n  - "Recovery"');
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

  test("quotes a plain title with no special characters, e.g. a trailing episode number", () => {
    const note = renderEpisodeNote(baseInput({ title: "Der Roadtrip #1" }));
    expect(note).toContain('title: "Der Roadtrip #1"');
  });

  test("escapes an embedded double quote", () => {
    const note = renderEpisodeNote(baseInput({ title: 'Er sagte "Hallo"' }));
    expect(note).toContain('title: "Er sagte \\"Hallo\\""');
  });

  test("escapes a backslash", () => {
    const note = renderEpisodeNote(baseInput({ title: "C:\\Users\\test" }));
    expect(note).toContain('title: "C:\\\\Users\\\\test"');
  });

  test("includes abs when present", () => {
    const note = renderEpisodeNote(baseInput({ absItemId: "abs-item-1" }));
    expect(note).toContain("abs: abs-item-1");
  });

  test("writes topics: [] when there are none", () => {
    const note = renderEpisodeNote(baseInput({ profile: { ...PROFILE, topics: [] } }));
    expect(note).toContain("topics: []");
  });

  test("does not duplicate a multi-paragraph description", () => {
    const note = renderEpisodeNote(baseInput({ transcriptMarkdown: MULTI_PARAGRAPH_TRANSCRIPT_MARKDOWN }));
    const afterTranskript = note.split("## Transkript")[1] ?? "";
    expect(afterTranskript).not.toContain("First paragraph of the description.");
    expect(afterTranskript).not.toContain("Second paragraph of the description.");
    expect(afterTranskript).toContain("## Segment One");
    expect(afterTranskript).toContain("**Jonas:** Hallo und willkommen.");
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
    const lockRoot = mkdtempSync(join(tmpdir(), "brain-lock-test-"));
    const lockDir = join(lockRoot, "lock");
    try {
      const result = await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir }));

      expect(existsSync(result.path)).toBe(true);
      expect(result.path.endsWith("2026-09-06 Test Episode.md")).toBe(true);

      const folderNotePath = join(vault, "Areas", "Podcasts", "Podcasts.md");
      expect(existsSync(folderNotePath)).toBe(true);
      const folderNote = readFileSync(folderNotePath, "utf8");
      expect(folderNote).toContain("2026-09-06 Test Episode|Test Episode");

      expect(result.committed).toBe(true);
      expect(result.pushed).toBe(true);
      expect(existsSync(lockDir)).toBe(false); // released once the git chain finished

      const log = Bun.spawnSync(["git", "log", "--oneline", "-1"], { cwd: vault });
      expect(log.stdout.toString()).toContain("podcast: Test Episode");

      const remoteLog = Bun.spawnSync(["git", "log", "--oneline", "-1", "main"], { cwd: remote });
      expect(remoteLog.stdout.toString()).toContain("podcast: Test Episode");
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test("returns committed:false without throwing when the directory is not a git repo", async () => {
    const plainDir = mkdtempSync(join(tmpdir(), "brain-plain-"));
    const lockRoot = mkdtempSync(join(tmpdir(), "brain-lock-test-"));
    const lockDir = join(lockRoot, "lock");
    try {
      const result = await writeEpisodeBrainNote(baseInput({ brainDir: plainDir, lockDir }));
      expect(existsSync(result.path)).toBe(true);
      expect(result.committed).toBe(false);
      expect(result.pushed).toBe(false);
    } finally {
      rmSync(plainDir, { recursive: true, force: true });
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test("waits for a held brain-sync lock, then proceeds once it's released", async () => {
    const { vault, remote } = initVaultWithBareRemote();
    const lockRoot = mkdtempSync(join(tmpdir(), "brain-lock-test-"));
    const lockDir = join(lockRoot, "lock");
    mkdirSync(lockDir); // simulate brain-sync.sh holding the lock right now
    const releaseTimer = setTimeout(() => rmSync(lockDir, { recursive: true, force: true }), 30);
    try {
      const result = await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir, lockRetryAttempts: 10, lockRetryDelayMs: 20 }));
      expect(result.committed).toBe(true);
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      clearTimeout(releaseTimer);
      rmSync(vault, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });

  test("never removes a lock it did not create, and skips the git chain while it stays busy", async () => {
    const { vault, remote } = initVaultWithBareRemote();
    const lockRoot = mkdtempSync(join(tmpdir(), "brain-lock-test-"));
    const lockDir = join(lockRoot, "lock");
    mkdirSync(lockDir); // held by "someone else" for the whole test
    try {
      const result = await writeEpisodeBrainNote(baseInput({ brainDir: vault, lockDir, lockRetryAttempts: 1, lockRetryDelayMs: 5 }));
      expect(result.committed).toBe(false);
      expect(result.pushed).toBe(false);
      expect(existsSync(lockDir)).toBe(true); // not ours — must survive
    } finally {
      rmSync(vault, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
      rmSync(lockRoot, { recursive: true, force: true });
    }
  });
});
