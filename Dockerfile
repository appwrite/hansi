# The review service. One image runs the worker; it has no build step, Bun runs the sources.

FROM oven/bun:1.4.4-slim

# The review's tools run git (checkouts, history) and ripgrep (grep). Nothing from a reviewed
# repository runs in this container: commands go to orchestrator sandboxes.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates git ripgrep \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Manifests first, so a source change does not reinstall dependencies.
COPY package.json bun.lock ./
COPY apps/service/package.json apps/service/
COPY packages/appwrite/package.json packages/appwrite/
COPY packages/engine/package.json packages/engine/
COPY packages/github/package.json packages/github/
COPY packages/sandbox/package.json packages/sandbox/
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY apps apps
COPY packages packages

ENV NODE_ENV=production \
	HANSI_PORT=8080
EXPOSE 8080
USER bun
# Bun as PID 1 gets SIGTERM directly and drains running jobs before it exits.
CMD ["bun", "apps/service/src/index.ts"]
