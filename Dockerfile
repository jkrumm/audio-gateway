# ffmpeg + ffprobe as fully-static binaries (built with libmp3lame + libopus, no
# shared-lib deps), copied from a pinned builder image. We deliberately avoid
# Debian's `apt install ffmpeg`: that produced a single 484MB layer which the
# registry rejected with HTTP 413 (Cloudflare's 100MB per-blob upload limit) — and
# would break the GitHub Actions deploy too, not just the bootstrap. Copied as two
# separate layers so neither approaches that limit.
FROM mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4 AS ffmpeg

FROM oven/bun:1

# curl is the only reason apt is touched here — it backs the HEALTHCHECK.
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*

COPY --from=ffmpeg /ffmpeg /usr/local/bin/ffmpeg
COPY --from=ffmpeg /ffprobe /usr/local/bin/ffprobe

WORKDIR /app

COPY package.json bun.lock ./
# No runtime deps — this validates the lockfile and skips devDeps, keeping the image lean.
RUN bun install --frozen-lockfile --production

COPY src/ ./src/
COPY tsconfig.json ./

EXPOSE 7714

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:7714/health || exit 1

CMD ["bun", "src/index.ts"]
