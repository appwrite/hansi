# The toolchain review sandboxes run in (HANSI_SANDBOX_IMAGE): what most repositories build and
# test with, so the agents' commands need no setup first. Anything else installs over the network.
# The orchestrator copies its sandbox agent into the workspace, so the image serves nothing itself.

FROM golang:1.27-bookworm@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea AS go

FROM node:26-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git unzip \
		python3 python3-pip python3-venv \
		php-cli php-curl php-intl php-mbstring php-mysql php-pgsql php-sqlite3 php-xml php-zip \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=composer:2@sha256:919efe8e62179c71dfd31fad035fd671fe7454211c6b2aa30a10af0ab4acedba /usr/bin/composer /usr/local/bin/composer
COPY --from=go /usr/local/go /usr/local/go

# The orchestrator runs sandboxes as an unnamed non-root user on a read-only root filesystem,
# with the workspace and /tmp writable: the package managers' caches (npm, pip, Composer, Go)
# follow HOME there.
ENV PATH=/usr/local/go/bin:$PATH \
	HOME=/tmp \
	CI=true
