# The toolchain review sandboxes run in (HANSI_SANDBOX_IMAGE): what most repositories build and
# test with, so the agents' commands need no setup first. Anything else installs over the network.
# The orchestrator copies its sandbox agent into the workspace, so the image serves nothing itself.

FROM golang:1.27-bookworm@sha256:b754301872c53d3dff666ec39e3fae971dc6f5ecd5a9b01fdefabbebb0f59901 AS go

FROM node:26-bookworm-slim@sha256:0042e17d232a87a2cd485be1da7900fca4d10a4ad11b29e9285da1d2e54798c9

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		build-essential ca-certificates curl git unzip \
		python3 python3-pip python3-venv \
		php-cli php-curl php-intl php-mbstring php-mysql php-pgsql php-sqlite3 php-xml php-zip \
	&& rm -rf /var/lib/apt/lists/*

COPY --from=composer:2@sha256:cd3a90dc5624c59a2f9ddf80dad08569f06416db31de519024f249d63bca554b /usr/bin/composer /usr/local/bin/composer
COPY --from=go /usr/local/go /usr/local/go

# The orchestrator runs sandboxes as an unnamed non-root user on a read-only root filesystem,
# with the workspace and /tmp writable: the package managers' caches (npm, pip, Composer, Go)
# follow HOME there.
ENV PATH=/usr/local/go/bin:$PATH \
	HOME=/tmp \
	CI=true
