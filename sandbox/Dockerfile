# The toolchain review sandboxes run in (HANSI_SANDBOX_IMAGE): what most repositories build and
# test with, so the agents' commands need no setup first. Anything else installs over the network.
# The orchestrator copies its sandbox agent into the workspace, so the image serves nothing itself.

FROM golang:1.25-bookworm AS go

FROM node:22-bookworm-slim

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git unzip \
		python3 python3-pip python3-venv \
		php-cli php-curl php-intl php-mbstring php-mysql php-pgsql php-sqlite3 php-xml php-zip \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=composer:2 /usr/bin/composer /usr/local/bin/composer
COPY --from=go /usr/local/go /usr/local/go

# The orchestrator runs sandboxes as an unnamed non-root user on a read-only root filesystem,
# with the workspace and /tmp writable: the package managers' caches (npm, pip, Composer, Go)
# follow HOME there.
ENV PATH=/usr/local/go/bin:$PATH \
	HOME=/tmp \
	CI=true
