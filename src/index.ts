import { config } from "./config";
import { iuHeaders, iuUrl } from "./iu";
import { log } from "./log";
import { flushOtel } from "./otel";
import { handlePodcasts, isPodcastPath, podcastRunning, recoverPodcastJobs } from "./podcasts";
import { handleSpeech } from "./speech";
import { handleTranscriptions } from "./transcriptions";

// ---------------------------------------------------------------------------
// Graceful-shutdown state (Decision 5)
// ---------------------------------------------------------------------------

/** Flip to true on SIGTERM/SIGINT — makes /health return 503 immediately. */
let draining = false;
/** Number of requests currently being processed (excluding /health). */
let inFlight = 0;

/** Toggle the draining flag — exported for tests. */
export function setDraining(v: boolean): void {
  draining = v;
}

/** Bearer token from the Authorization header, if shaped like `Bearer <token>`. */
const bearerToken = (req: Request): string | undefined => {
  const header = req.headers.get("authorization");
  return header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
};

/**
 * Caller name for a request authenticated via a mapped AUDIO_CALLER_TOKENS entry
 * (config.ts), or undefined if its bearer token isn't in the map. Used both by
 * `authorized()` below (a mapped token is accepted exactly like PROXY_API_KEY)
 * and by handleRequest to seed `audio.caller` for clients that can't send
 * `x-audio-source` — an explicit header still wins there.
 */
const callerFromToken = (req: Request): string | undefined => {
  const token = bearerToken(req);
  return token ? config.audioCallerTokens[token] : undefined;
};

/**
 * Optional bearer-token gate. No-op when PROXY_API_KEY is unset. A mapped
 * AUDIO_CALLER_TOKENS entry is accepted exactly like PROXY_API_KEY.
 */
const authorized = (req: Request): boolean => {
  if (!config.proxyApiKey) return true;
  if (req.headers.get("authorization") === `Bearer ${config.proxyApiKey}`) return true;
  return callerFromToken(req) !== undefined;
};

async function handleModels(): Promise<Response> {
  // GET /models: passthrough, not logged (dead 'models' enum dropped — Decision 2).
  const res = await fetch(iuUrl("/models"), { headers: iuHeaders() });
  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

/**
 * Core request handler — exported so tests can call it with synthetic Requests.
 * `Bun.serve` just wraps this.
 */
export async function handleRequest(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname;

  // /health is answered before auth and before draining check.
  if (req.method === "GET" && path === "/health") {
    if (draining) {
      return Response.json({ ok: false, service: "audio-gateway", draining: true }, { status: 503 });
    }
    return Response.json({ ok: true, service: "audio-gateway" });
  }

  // During graceful drain, reject new work (but /health above still answers 503).
  if (draining) {
    return Response.json({ error: { message: "service is shutting down", type: "proxy_error" } }, { status: 503 });
  }

  if (!authorized(req)) {
    return Response.json({ error: { message: "unauthorized", type: "invalid_request_error" } }, { status: 401 });
  }

  inFlight++;
  try {
    // Match regardless of /v1 prefix so OpenAI clients with either base form work.
    if (req.method === "POST" && path.endsWith("/audio/transcriptions")) {
      return await handleTranscriptions(req, callerFromToken(req));
    }
    if (req.method === "POST" && path.endsWith("/audio/speech")) return await handleSpeech(req, callerFromToken(req));
    if (req.method === "GET" && path.endsWith("/models")) return await handleModels();
    if (isPodcastPath(path)) return await handlePodcasts(req, path, callerFromToken(req));
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    return Response.json({ error: { message, type: "proxy_error" } }, { status: 500 });
  } finally {
    inFlight--;
  }

  return Response.json({ error: { message: `no route for ${req.method} ${path}`, type: "not_found" } }, { status: 404 });
}

// ---------------------------------------------------------------------------
// Server bootstrap — only when run directly (`bun src/index.ts`), so importing
// this module in tests does NOT bind the port or register signal handlers.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  recoverPodcastJobs();

  const server = Bun.serve({
    port: config.port,
    idleTimeout: 255, // transcription of longer clips can take a while
    fetch: handleRequest,
  });

  log.info(`audio-gateway listening on http://localhost:${server.port} → ${config.iuBaseUrl}`, {
    port: server.port,
    iuBaseUrl: config.iuBaseUrl,
  });

  // Graceful shutdown (Decision 5): SIGTERM + SIGINT.
  const shutdown = async (signal: string): Promise<void> => {
    log.info(`audio-gateway received ${signal}, starting graceful shutdown`, { signal });
    setDraining(true);

    // Wait for in-flight requests (and a running podcast job) to complete, up to shutdownDrainMs.
    const deadline = Date.now() + config.shutdownDrainMs;
    while ((inFlight > 0 || podcastRunning()) && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    if (inFlight > 0 || podcastRunning()) {
      log.warn(`audio-gateway shutdown: ${inFlight} request(s) (podcast job running: ${podcastRunning()}) still in flight after drain timeout`, {
        inFlight,
        podcastRunning: podcastRunning(),
      });
    }

    await flushOtel();
    server.stop();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
