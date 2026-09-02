import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Podcast assembly + mastering — the ffmpeg process boundary for the
// long-form pipeline (mirrors audio.ts's role for the short-form TTS lanes).
// `concatWithGaps`/`buildFfmetadata` are pure; `masterPodcastMp3` is the only
// function that touches ffmpeg or the filesystem.

const BYTES_PER_SAMPLE = 2; // s16le mono

export interface MuxTurn {
  pcm: Uint8Array;
  sampleRate: number;
  gapMsAfter: number;
}

export interface MuxResult {
  pcm: Uint8Array;
  sampleRate: number;
  /** Start offset of each turn's own audio (excluding its trailing gap), in ms — chapter math. */
  turnStartsMs: number[];
  totalMs: number;
}

/**
 * Concatenate s16le mono turns, inserting `gapMsAfter` of digital silence
 * after each. All turns must share `sampleRate` — mixing rates here would
 * silently mis-time every gap and chapter boundary downstream.
 */
export function concatWithGaps(turns: MuxTurn[]): MuxResult {
  const first = turns[0];
  if (!first) return { pcm: new Uint8Array(0), sampleRate: 0, turnStartsMs: [], totalMs: 0 };

  const sampleRate = first.sampleRate;
  if (turns.some((t) => t.sampleRate !== sampleRate)) {
    throw new Error("concatWithGaps: all turns must share the same sampleRate");
  }

  const bytesPerMs = (sampleRate * BYTES_PER_SAMPLE) / 1000;
  const turnStartsMs: number[] = [];
  let totalBytes = 0;
  let totalMs = 0;
  for (const turn of turns) {
    turnStartsMs.push(totalMs);
    const gapBytes = Math.round(bytesPerMs * turn.gapMsAfter);
    totalBytes += turn.pcm.byteLength + gapBytes;
    totalMs += turn.pcm.byteLength / bytesPerMs + turn.gapMsAfter;
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const turn of turns) {
    out.set(turn.pcm, offset);
    offset += turn.pcm.byteLength;
    offset += Math.round(bytesPerMs * turn.gapMsAfter); // leave zeroed silence
  }

  return { pcm: out, sampleRate, turnStartsMs, totalMs };
}

export interface Chapter {
  title: string;
  startMs: number;
}

export interface EpisodeTags {
  title: string;
  album: string;
  artist: string;
  albumArtist: string;
  comment: string;
  /** YYYY-MM-DD */
  date: string;
  genre: string;
  /** ISO 639-2, e.g. "deu" */
  language: string;
  track: number;
}

export interface MasterOptions {
  chapters: Chapter[];
  tags: EpisodeTags;
  /** PNG bytes; omit to master without embedded cover art. */
  cover?: Uint8Array;
  bitrateKbps: number;
}

/** Escape `=`, `;`, `#`, `\`, and newlines per the ffmetadata spec (backslash first, so its own escaping isn't re-escaped). */
function escapeFfmetadata(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/[=;#\n]/g, (c) => `\\${c}`);
}

/**
 * Build an `;FFMETADATA1` document: global tags, then one `[CHAPTER]` block
 * per entry with `TIMEBASE=1/1000` — each chapter's END is the next chapter's
 * START, or `totalMs` for the last one. Pure — no ffmpeg, no filesystem —
 * exported so the escaping/chapter math is directly unit-testable.
 */
export function buildFfmetadata(chapters: Chapter[], totalMs: number, tags: EpisodeTags): string {
  const tag = (key: string, value: string): string => `${key}=${escapeFfmetadata(value)}`;
  const lines = [
    ";FFMETADATA1",
    tag("title", tags.title),
    tag("artist", tags.artist),
    tag("album", tags.album),
    tag("album_artist", tags.albumArtist),
    tag("comment", tags.comment),
    tag("date", tags.date),
    tag("genre", tags.genre),
    tag("language", tags.language),
    `track=${tags.track}`,
  ];

  chapters.forEach((chapter, i) => {
    const end = chapters[i + 1]?.startMs ?? totalMs;
    lines.push("", "[CHAPTER]", "TIMEBASE=1/1000", `START=${chapter.startMs}`, `END=${end}`, tag("title", chapter.title));
  });

  return `${lines.join("\n")}\n`;
}

/**
 * Master raw s16le PCM into a loudness-normalised (podcast-standard
 * `loudnorm I=-16 TP=-1.5 LRA=11`), 44.1 kHz mono MP3 with ID3v2.3 tags,
 * CHAP/CTOC chapters, and an optional embedded cover. Writes ffmetadata +
 * cover to a temp dir (cleaned up in `finally`) and spawns ffmpeg with the
 * PCM on stdin — output goes to a seekable temp FILE, not stdout, because the
 * ID3 header (which precedes the audio and carries the attached picture)
 * can't be written to a pipe. Mirrors audio.ts's `transcode`: stderr is read
 * concurrently with the stdin write so a large buffer can't deadlock the pipe.
 */
export async function masterPodcastMp3(pcm: Uint8Array, sampleRate: number, opts: MasterOptions): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "audio-gateway-podcast-"));
  try {
    const totalMs = pcm.byteLength / ((sampleRate * BYTES_PER_SAMPLE) / 1000);
    const metaPath = join(dir, "meta.txt");
    const outPath = join(dir, "episode.mp3");
    await writeFile(metaPath, buildFfmetadata(opts.chapters, totalMs, opts.tags), "utf8");

    const args = [
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
      "-f", "s16le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0",
      "-i", metaPath,
    ];

    if (opts.cover) {
      const coverPath = join(dir, "cover.png");
      await writeFile(coverPath, opts.cover);
      args.push("-i", coverPath, "-map_metadata", "1", "-map", "0:a", "-map", "2:v", "-c:v", "copy", "-disposition:v", "attached_pic", "-metadata:s:v", "title=Cover", "-metadata:s:v", "comment=Cover (front)");
    } else {
      args.push("-map_metadata", "1", "-map", "0:a");
    }

    args.push(
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=11",
      "-ar", "44100", "-ac", "1",
      "-c:a", "libmp3lame", "-b:a", `${opts.bitrateKbps}k`,
      "-id3v2_version", "3", "-write_id3v1", "1",
      outPath,
    );

    const proc = Bun.spawn(args, { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
    const stderrPromise = new Response(proc.stderr).text();
    proc.stdin.write(pcm);
    await proc.stdin.end();
    const [errText, exitCode] = await Promise.all([stderrPromise, proc.exited]);
    if (exitCode !== 0) {
      throw new Error(`ffmpeg podcast mastering failed (${exitCode}): ${errText.slice(0, 500)}`);
    }

    return new Uint8Array(await readFile(outPath));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
