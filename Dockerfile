# Debian-slim base: ships the full ffmpeg build with libmp3lame + libopus,
# and provides both ffmpeg AND ffprobe. curl is for the HEALTHCHECK.
FROM oven/bun:1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl && rm -rf /var/lib/apt/lists/*

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
