# The toolchain review sandboxes run in (HANSI_SANDBOX_IMAGE): what most repositories build and
# test with, so the agents' commands need no setup first. Anything else installs over the network.
# The orchestrator copies its sandbox agent into the workspace, so the image serves nothing itself.

FROM golang:1.27-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0 AS go

FROM node:26-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git unzip \
		python3 python3-pip python3-venv \
		php-cli php-curl php-intl php-mbstring php-mysql php-pgsql php-sqlite3 php-xml php-zip \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=composer:2@sha256:8de2184c6de224f4689e8f80ed5f5edaf0030b6b8b7839a22a2bcb6722ac87d0 /usr/bin/composer /usr/local/bin/composer
COPY --from=go /usr/local/go /usr/local/go

# The orchestrator runs sandboxes as an unnamed non-root user on a read-only root filesystem,
# with the workspace and /tmp writable: the package managers' caches (npm, pip, Composer, Go)
# follow HOME there.
ENV PATH=/usr/local/go/bin:$PATH \
	HOME=/tmp \
	CI=true
