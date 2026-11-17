# The review service. One image, two processes: Bun runs the service from its sources, and
# starts the queue consumer, which reads Appwrite's queue with Appwrite's own PHP queue library
# and hands each job to the service on loopback.

FROM composer:2@sha256:0c8e663f14c94d07b3c45b175c51f5a14718508f21fe4dd7e54f09488dd0ed71 AS consumer

WORKDIR /app/apps/consumer
COPY apps/consumer/composer.json apps/consumer/composer.lock ./
# The platform is the runtime stage's, which composer's own image does not have.
RUN composer install --no-dev --no-interaction --no-progress --prefer-dist \
	--ignore-platform-reqs --optimize-autoloader

FROM oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a AS bun

# PHP 8.5 with Swoole, Redis and igbinary: the runtime Appwrite's own workers read queues on.
FROM appwrite/base:2.2.9@sha256:ff6285b8621dd4863c6522737727904e109bd81f05e46b46dc2ef7e86d806b86

# The review's tools run git (checkouts, history) and ripgrep (grep). Nothing from a reviewed
# repository runs in this container: commands go to orchestrator sandboxes.
RUN apk add --no-cache ca-certificates git ripgrep libstdc++ libgcc \
	&& adduser -D -H -u 1000 hansi
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app

# Manifests first, so a source change does not reinstall dependencies.
COPY package.json bun.lock ./
COPY apps/service/package.json apps/service/
COPY packages/appwrite/package.json packages/appwrite/
COPY packages/bitbucket/package.json packages/bitbucket/
COPY packages/engine/package.json packages/engine/
COPY packages/gitea/package.json packages/gitea/
COPY packages/github/package.json packages/github/
COPY packages/gitlab/package.json packages/gitlab/
COPY packages/origin/package.json packages/origin/
COPY packages/sandbox/package.json packages/sandbox/
RUN bun install --frozen-lockfile --production --ignore-scripts

COPY --from=consumer /app/apps/consumer/vendor apps/consumer/vendor
COPY apps apps
COPY packages packages

ENV NODE_ENV=production \
	HANSI_PORT=8080 \
	HANSI_CONSUMER_COMMAND="php /app/apps/consumer/consumer.php"
EXPOSE 8080
USER hansi
# Bun as PID 1 gets SIGTERM directly: it stops the consumer, which stops receiving and settles
# what it holds once the jobs it handed over finish.
CMD ["bun", "apps/service/src/index.ts"]
