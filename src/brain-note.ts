/**
 * The transcript note written back into the second brain after a podcast
 * episode finishes (docs/podcast-editorial-room.md §6). Best-effort: a write
 * or git-sync failure never throws — it's logged and reflected in the
 * returned `{ committed, pushed }` flags, since a finished episode must not
 * fail the job just because the note couldn't be filed. Follows
 * ~/SourceRoot/brain/AGENTS.md's folder-note convention: the folder note
 * lives at `Areas/Podcasts/Podcasts.md`, same name as its folder.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { log } from "./log";
import type { EpisodeProfile } from "./podcast-types";

export interface EpisodeNoteInput {
  brainDir: string;
  jobId: string;
  title: string;
  description: string;
  series: string;
  /** ISO timestamp. */
  createdAt: string;
  profile: EpisodeProfile;
  /** The caller renders this (`podcasts.ts`'s `renderTranscriptMarkdown`). */
  transcriptMarkdown: string;
  absItemId?: string | null;
}

const FOLDER_NOTE_TITLE = "Podcasts";

// ---------------------------------------------------------------------------
// Pure rendering
// ---------------------------------------------------------------------------

/** YAML-significant characters at the start of a scalar that force quoting. */
const SPECIAL_START = /^[-?:,[\]{}#&*!|>'"%@`]/;

function yamlScalar(value: string): string {
  if (value.includes(":") || SPECIAL_START.test(value)) {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return value;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildFrontmatter(input: EpisodeNoteInput): string {
  const date = input.createdAt.slice(0, 10);
  const lines: string[] = [
    "---",
    `title: ${yamlScalar(input.title)}`,
    `date: ${date}`,
    `tags: [podcast, ${slugify(input.series)}]`,
    `series: ${yamlScalar(input.series)}`,
    `format: ${yamlScalar(input.profile.format)}`,
    `lead: ${input.profile.lead}`,
    `humor: ${input.profile.humor}`,
    `minutes: ${input.profile.minutes}`,
  ];
  if (input.profile.topics.length > 0) {
    lines.push("topics:");
    for (const topic of input.profile.topics) lines.push(`  - ${yamlScalar(topic)}`);
  } else {
    lines.push("topics: []");
  }
  lines.push(`job: ${input.jobId}`);
  if (input.absItemId) lines.push(`abs: ${input.absItemId}`);
  lines.push("---");
  return lines.join("\n");
}

/**
 * `renderTranscriptMarkdown` (podcasts.ts) always opens with `# <title>\n\n<description>\n\n`
 * before the first `## <segment>` heading — strip that prefix so the episode
 * note's own `# <title>` + description aren't duplicated above "## Transkript".
 */
function stripHeadingAndDescription(transcriptMarkdown: string): string {
  const parts = transcriptMarkdown.split("\n\n");
  if (parts[0]?.startsWith("# ")) return parts.slice(2).join("\n\n");
  return transcriptMarkdown;
}

/** Pure: builds the full episode note markdown (frontmatter + title + description + transcript). */
export function renderEpisodeNote(input: EpisodeNoteInput): string {
  const lines = [
    buildFrontmatter(input),
    "",
    `# ${input.title}`,
    "",
    input.description,
    "",
    "## Transkript",
    "",
    stripHeadingAndDescription(input.transcriptMarkdown),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/** "<yyyy-mm-dd> <title>.md" — title sanitized for a filename (umlauts kept). */
export function episodeNoteFilename(createdAt: string, title: string): string {
  const date = createdAt.slice(0, 10);
  const sanitized = title
    // Strips filesystem-hostile chars and control chars on purpose.
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${date} ${sanitized}.md`;
}

export interface FolderNoteEntry {
  file: string;
  title: string;
  date: string;
  format: string;
  minutes: number;
}

/** Pure: regenerates the folder note from a directory listing, newest first. */
export function renderFolderNote(entries: FolderNoteEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const lines = [
    "---",
    `title: ${FOLDER_NOTE_TITLE}`,
    "tags: [podcast]",
    "---",
    "",
    `# ${FOLDER_NOTE_TITLE}`,
    "",
    "Episoden der Brain-Podcast-Pipeline — automatisch generierte Transkript-Notizen.",
    "",
  ];
  for (const entry of sorted) {
    lines.push(`- [[${entry.file}|${entry.title}]] — ${entry.date} · ${entry.format} · ${entry.minutes} min`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// ---------------------------------------------------------------------------
// Filesystem + git (best-effort)
// ---------------------------------------------------------------------------

/** Tolerant `key: value` frontmatter scan, mirrors podcast-research.ts's — kept private/local since each caller's needs are tiny and distinct. */
function parseFrontmatter(raw: string): Record<string, string> {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return {};
  const frontmatter: Record<string, string> = {};
  for (const line of (match[1] ?? "").split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) frontmatter[key] = value;
  }
  return frontmatter;
}

async function collectFolderEntries(folderDir: string, folderNotePath: string): Promise<FolderNoteEntry[]> {
  let names: string[];
  try {
    names = await readdir(folderDir);
  } catch {
    return [];
  }
  const entries: FolderNoteEntry[] = [];
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const full = join(folderDir, name);
    if (full === folderNotePath) continue;
    let raw: string;
    try {
      raw = await readFile(full, "utf8");
    } catch {
      continue;
    }
    const frontmatter = parseFrontmatter(raw);
    const base = name.replace(/\.md$/i, "");
    entries.push({
      file: base,
      title: frontmatter["title"] ?? base,
      date: frontmatter["date"] ?? "",
      format: frontmatter["format"] ?? "",
      minutes: Number(frontmatter["minutes"] ?? "0") || 0,
    });
  }
  return entries;
}

/** Runs one git step in `cwd`; returns success, logging stderr on a non-zero exit. */
async function gitStep(cwd: string, args: string[], context: { jobId: string }): Promise<boolean> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    log.warn("brain note git step failed", { args, exitCode, stderr: stderr.slice(0, 500), jobId: context.jobId });
    return false;
  }
  return true;
}

/**
 * Write the episode note + regenerated folder note, then best-effort
 * `git add` / `git commit` / `git push` in `brainDir` — every step stops the
 * chain on failure (logged), never pulls, never touches any other file.
 */
export async function writeEpisodeBrainNote(input: EpisodeNoteInput): Promise<{ path: string; committed: boolean; pushed: boolean }> {
  const folderDir = join(input.brainDir, "Areas", "Podcasts");
  const notePath = join(folderDir, episodeNoteFilename(input.createdAt, input.title));
  const folderNotePath = join(folderDir, `${FOLDER_NOTE_TITLE}.md`);

  try {
    await mkdir(folderDir, { recursive: true });
    await writeFile(notePath, renderEpisodeNote(input), "utf8");
    const entries = await collectFolderEntries(folderDir, folderNotePath);
    await writeFile(folderNotePath, renderFolderNote(entries), "utf8");
  } catch (err) {
    log.warn("brain note write failed", { error: err instanceof Error ? err.message : String(err), jobId: input.jobId });
    return { path: notePath, committed: false, pushed: false };
  }

  const context = { jobId: input.jobId };
  if (!(await gitStep(input.brainDir, ["add", "--", notePath, folderNotePath], context))) {
    return { path: notePath, committed: false, pushed: false };
  }
  if (!(await gitStep(input.brainDir, ["commit", "-m", `podcast: ${input.title}`, "--", notePath, folderNotePath], context))) {
    return { path: notePath, committed: false, pushed: false };
  }
  const pushed = await gitStep(input.brainDir, ["push"], context);
  return { path: notePath, committed: true, pushed };
}
