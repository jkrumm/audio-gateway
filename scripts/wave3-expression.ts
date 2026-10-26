/**
 * wave3-expression — the listening proof for expression, synth-only, one question on /tts ("Expressiveness"):
 *   podcast: one finished script segment voiced 3 ways — A as today (no tags, constant style), B tag band, C tag band + per-turn delivery
 *   briefing: the new prep (vocabulary deliveries + tag band) vs the same text flattened (constant style, no tags)
 *   chat: plain vs caller-written inline tags + a caller delivery key
 * plus the "never spoken" check: every delivery key and every tag round-tripped through STT.
 *
 *   secrets-run run --env-file=.env.tpl --env-file=.env.mini.tpl -- bun scripts/wave3-expression.ts [podcast|briefing|chat|verify ...]
 */
import { existsSync, mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as inputs from "./lib/bakeoff-inputs";
import { SpendLedger } from "./lib/spend";
import { transcribe } from "./lib/stt";

mkdirSync("./data/wave3/audio", { recursive: true });
process.env["USAGE_DB"] = "./data/wave3/usage.db";
process.env["USAGE_SINK"] = "sqlite";

const { config } = await import("../src/config");
const script = await import("../src/podcast-script");
const core = await import("../src/gemini-tts-core");
const { lintSegments, expressionSummary } = await import("../src/podcast-lint");
const { synthesizeSegment } = await import("./lib/bakeoff-synth");
const tts = await import("../src/gemini-tts");
const audio = await import("../src/audio");

const ledger = new SpendLedger("./data/wave3/usage.db", Number(process.env["WAVE3_CAP_USD"] ?? 4), 0.4, Number(process.env["WAVE3_PRIOR_USD"] ?? 0.12));
ledger.installFetchGuard([new URL(config.iuBaseUrl).host, new URL(config.iuGeminiBaseUrl).host]);

const modes = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["verify", "podcast", "briefing", "chat"];
const hosts: [import("../src/podcast-script").PodcastHost, import("../src/podcast-script").PodcastHost] = [
  { id: "A", name: config.podcastHostNames[0], voice: config.podcastVoices[0], speed: config.podcastSpeeds[0] },
  { id: "B", name: config.podcastHostNames[1], voice: config.podcastVoices[1], speed: config.podcastSpeeds[1] },
];
const req = await inputs.loadRequest({ episodeId: inputs.DEFAULT_EPISODE_ID, hosts });
const AUDIO = "./data/wave3/audio";
const STYLE_WORDS = [...core.DELIVERY_KEYS, ...Object.values(core.DELIVERY_STYLES).flatMap((s) => s.split(/[,\s]+/)), "pause", "laugh", "chuckle", "sigh", "exhale", "breath", "whisper", "delivery", "style"].filter((w) => w.length > 3);
const leaked = (transcript: string): string[] => [...new Set(STYLE_WORDS.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(transcript)))];
const mp3Of = async (pcm: Uint8Array, sampleRate: number): Promise<Uint8Array> => new Uint8Array( (await audio.transcode(pcm, { kind: "pcm", sampleRate }, "mp3")).bytes);
const report: Record<string, unknown> = existsSync("./data/wave3/expression.json") ? JSON.parse(await readFile("./data/wave3/expression.json", "utf8")) : {};

async function speak(input: string, name: string, extra: { delivery?: string; model?: string } = {}): Promise<string> {
  ledger.guard(0.05);
  const res = await tts.handleGeminiSpeech({ model: extra.model ?? config.podcastTtsModel, input, voice: "Charon", responseFormat: "mp3", summarize: false, delivery: extra.delivery });
  const path = `${AUDIO}/${name}.mp3`;
  await Bun.write(path, await res.arrayBuffer());
  return path;
}

if (modes.includes("verify")) {
  // Every delivery key and every allowlisted tag on a neutral sentence: the transcript must hold the sentence and none of the style/tag words.
  const sentence = "Der Dienst läuft seit gestern wieder, und die Zahlen sehen ordentlich aus.";
  const results: Record<string, { leaked: string[]; transcript: string }> = {};
  for (const key of core.DELIVERY_KEYS) {
    const path = await speak(sentence, `verify-${key}`, { delivery: key });
    const transcript = await transcribe(path, config.iuBaseUrl, config.iuApiKey);
    results[`delivery:${key}`] = { leaked: leaked(transcript), transcript };
  }
  for (const tag of core.SPEECH_TAGS) {
    const path = await speak(`Der Dienst läuft seit gestern wieder. ${tag} Und die Zahlen sehen ordentlich aus.`, `verify-tag-${tag.replace(/\W+/g, "-")}`);
    const transcript = await transcribe(path, config.iuBaseUrl, config.iuApiKey);
    results[`tag:${tag}`] = { leaked: leaked(transcript), transcript };
  }
  for (const [k, v] of Object.entries(results)) console.log(`${v.leaked.length === 0 ? "clean " : "SPOKEN"} ${k}: ${v.transcript.slice(0, 110)}${v.leaked.length ? `  <- ${v.leaked.join(",")}` : ""}`);
  report["verify"] = results;
}

if (modes.includes("podcast")) {
  const prove = JSON.parse(await readFile("./data/writer-lab/prove-claude-opus-5-5.json", "utf8")) as { final: import("../src/podcast-script").ScriptSegment };
  const plain = (text: string): string => text.replace(core.TAG_PATTERN, " ").replace(/\s+/g, " ").trim();
  const base: import("../src/podcast-script").ScriptSegment = { title: prove.final.title, turns: prove.final.turns.map((t) => ({ speaker: t.speaker, text: plain(t.text) })) };

  const dress = async (segment: import("../src/podcast-script").ScriptSegment, instruction: string): Promise<import("../src/podcast-script").ScriptSegment> => {
    const render = segment.turns.map((t, i) => `[turn ${i}] ${t.speaker}${t.delivery ? ` {delivery: ${t.delivery}}` : ""}: ${t.text}`).join("\n");
    for (let attempt = 1; attempt <= 2; attempt++) {
      ledger.guard(0.15);
      const raw = await script.callPodcastLlm({
        model: "claude-sonnet-5-5",
        systemPrompt: `You are the delivery editor of a two-host German podcast. You get a finished script segment and add expression WITHOUT changing a single word, number, punctuation mark or turn boundary of the spoken text.\n\n${instruction}\n\nReturn STRICT JSON only: {"turns":[{"speaker":"A"|"B","text":"...","delivery":"<optional>"}]} — the same turns in the same order, with the same words.`,
        userContent: render,
        maxCompletionTokens: 20000,
        stage: "segment",
        usageEndpoint: "podcast-segment",
        jsonSchema: script.SEGMENT_TURNS_SCHEMA,
      });
      const turns = script.parseSegmentTurns(raw);
      const same = turns.length === segment.turns.length && turns.every((t, i) => plain(t.text) === plain(segment.turns[i]!.text) && t.speaker === segment.turns[i]!.speaker);
      if (same) return { title: segment.title, turns: turns.map((t) => ({ ...t, text: core.stripDisallowedTags(t.text) })) };
      // a dress that ignored the rules is not a result
      console.warn(`dress attempt ${attempt}: words changed, retrying`);
    }
    throw new Error("the delivery editor kept changing words");
  };

  const tagRule = `INLINE TAGS: add ${core.SPEECH_TAGS.join(" ")} (exactly, angle brackets, English). Place a few well-placed ones where a real person would pause or react: a <short pause> before a number or a turn in the argument, a <long pause> at most once for weight, a reaction (<chuckle>, <laugh>, <sigh>) only where something is actually funny or tiresome. Roughly one tag every four to eight turns; only inside turns of twelve words or more, between two sentences; never as the first word of a short line; never two tags side by side. Do not add or change any "delivery" field.`;
  const deliveryRule = `PER-TURN DELIVERY: keep the inline tags exactly as they are. Add a "delivery" field ONLY on a turn where the moment changes — a host turns curious, amused, surprised, serious, has to think, speeds up, goes dry, reassures — using exactly one of: ${core.DELIVERY_KEYS.join(", ")}. Only about one turn in five or six gets one (four to six in a segment of this length); never the same delivery on three turns in a row; never on a line of fewer than eight words; every other turn stays at baseline with no field.`;

  const bDressed = existsSync("./data/wave3/expr-b.json") ? (JSON.parse(await readFile("./data/wave3/expr-b.json", "utf8")) as typeof base) : await dress(base, tagRule);
  // B isolates the tags: a delivery the editor added anyway is dropped.
  const b = { title: bDressed.title, turns: bDressed.turns.map((t) => ({ speaker: t.speaker, text: t.text })) };
  await writeFile("./data/wave3/expr-b.json", JSON.stringify(b, null, 2));
  const c = existsSync("./data/wave3/expr-c.json") ? (JSON.parse(await readFile("./data/wave3/expr-c.json", "utf8")) as typeof base) : await dress(b, deliveryRule);
  await writeFile("./data/wave3/expr-c.json", JSON.stringify(c, null, 2));

  const lintOpts = { hostNames: hosts.map((h) => h.name), glossaryTerms: [] as string[], source: req.source };
  const summary: Record<string, unknown> = {};
  for (const [key, seg] of [["a", base], ["b", b], ["c", c]] as const) {
    const lint = lintSegments([seg], lintOpts);
    summary[key] = { ...expressionSummary(lint), turns: seg.turns.length, expressionFindings: lint.findings.filter((f) => f.rule.startsWith("tag") || f.rule.startsWith("delivery") || f.rule === "caps-emphasis").map((f) => `${f.rule}@${f.turnIndex ?? "seg"}`) };
    const out = `${AUDIO}/expr__${key}.mp3`;
    if (!existsSync(out)) {
      ledger.guard(0.1);
      await synthesizeSegment(req, seg, out);
    }
    const transcript = key === "a" ? "" : await transcribe(out, config.iuBaseUrl, config.iuApiKey);
    (summary[key] as Record<string, unknown>)["leaked"] = leaked(transcript);
    console.log(`${key}: ${JSON.stringify(summary[key])}`);
  }
  report["podcast"] = summary;
}

if (modes.includes("briefing")) {
  const text = (await readFile("./data/wave3/briefing-text.txt", "utf8")).trim();
  ledger.guard(0.1);
  const { prep } = await tts.runPrep("gemini-3.8-flash-tts", text, false);
  await writeFile("./data/wave3/briefing-prep.json", JSON.stringify(prep, null, 2));
  const render = async (chunks: Array<{ style: string; text: string }>, name: string): Promise<string> => {
    ledger.guard(0.05);
    const parts = await tts.synthChunksConcurrent("gemini-3.8-flash-tts", "Charon", core.enforceChunkLimits(chunks, { targetWords: 110, maxWords: 150, maxBytes: 1200 }));
    const joined = audio.concatPcm(parts);
    const path = `${AUDIO}/${name}.mp3`;
    await writeFile(path, await mp3Of(joined.pcm, joined.sampleRate));
    return path;
  };
  const flat = prep.chunks.map((c) => ({ style: tts.PREP_STYLE, text: c.text.replace(core.TAG_PATTERN, " ").replace(/\s+/g, " ").trim() }));
  await render(flat, "briefing__baseline");
  const expressivePath = await render(prep.chunks, "briefing__expressive");
  const transcript = await transcribe(expressivePath, config.iuBaseUrl, config.iuApiKey);
  report["briefing"] = { chunks: prep.chunks.map((c) => ({ style: c.style || "baseline", tags: (c.text.match(core.TAG_PATTERN) ?? []).length })), leaked: leaked(transcript) };
  console.log(JSON.stringify(report["briefing"]));
}

if (modes.includes("chat")) {
  const plainText = "Klar, das habe ich gemacht. Der Termin ist eingetragen, und ich erinnere dich eine Stunde vorher. Übrigens: Der Zug fällt aus, den du nehmen wolltest. Soll ich dir eine Alternative suchen?";
  const taggedText = "Klar, das habe ich gemacht. <short pause> Der Termin ist eingetragen, und ich erinnere dich eine Stunde vorher. Übrigens: <long pause> Der Zug fällt aus, den du nehmen wolltest. <sigh> Soll ich dir eine Alternative suchen?";
  await speak(plainText, "chat__plain", { model: "gemini-3.8-flash-lite-tts" });
  const taggedPath = await speak(taggedText, "chat__tagged", { model: "gemini-3.8-flash-lite-tts", delivery: "warm" });
  const transcript = await transcribe(taggedPath, config.iuBaseUrl, config.iuApiKey);
  report["chat"] = { leaked: leaked(transcript), transcript };
  console.log(JSON.stringify(report["chat"]));
}

await writeFile("./data/wave3/expression.json", JSON.stringify(report, null, 2));
console.log(`spent (Wave 3 ledger + prior) $${ledger.spent().toFixed(3)} of $${ledger.capUsd}`);
