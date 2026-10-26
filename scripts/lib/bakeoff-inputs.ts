/** Shared inputs of the writer harnesses: one finished episode's request, brief and dossier, plus the frozen outline. */
import { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Outline, PodcastScriptRequest } from "../../src/podcast-script";

export const DEFAULT_EPISODE_ID = "8ee3a4df-445a-4e57-ae37-d151aea362a5";

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function loadRequest(params: { episodeId: string; hosts: PodcastScriptRequest["hosts"] }): Promise<PodcastScriptRequest> {
  const ledger = new Database("./data/podcasts.db", { readonly: true });
  const row = ledger.query("SELECT request_json FROM podcast_job WHERE id = ?").get(params.episodeId) as { request_json: string } | null;
  ledger.close();
  if (!row) throw new Error(`episode ${params.episodeId} not in data/podcasts.db`);
  const request = JSON.parse(row.request_json) as { source: string; brief?: string; title?: string; language: "de" | "en"; minutes: number; series: string };
  const dir = join("./data/podcasts", params.episodeId);
  return {
    source: request.source,
    brief: request.brief,
    title: request.title,
    language: request.language,
    minutes: request.minutes,
    hosts: params.hosts,
    series: request.series,
    dossier: await readJson(join(dir, "dossier.json")),
    episodeBrief: await readJson(join(dir, "brief.json")),
  };
}

export const loadFrozenOutline = (): Promise<Outline> => readJson<Outline>("./data/writer-bakeoff/outline.json");
