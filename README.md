<p align="center">
    <h1>Hansi</h1>
    <b>AI code review for Appwrite. Hansi reviews your GitHub pull requests, checks its own findings against the code before it posts them, and answers questions in the thread.</b>
    <br />
    <br />
</p>

[![Discord](https://img.shields.io/badge/chat-5865F2?style=flat-square&logo=discord&logoColor=white)](https://appwrite.io/discord)
[![X](https://img.shields.io/badge/follow-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/appwrite)
[![Appwrite Cloud](https://img.shields.io/badge/Cloud-F02E65?style=flat-square&logo=icloud&logoColor=white)](https://cloud.appwrite.io)
[![CI](https://img.shields.io/github/actions/workflow/status/appwrite/hansi/ci.yml?branch=main&label=ci&style=flat-square)](https://github.com/appwrite/hansi/actions/workflows/ci.yml)
[![Image](https://img.shields.io/badge/image-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/appwrite/hansi/pkgs/container/hansi)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue?style=flat-square)](./LICENSE)

Hansi is the service behind **Review** in the Appwrite Console. Connect a GitHub repository to a project, and every pull request gets a review: inline comments on the lines that matter, a merge-confidence tier, and an approval or a request for changes. Mention Hansi on a pull request and it answers.

Hansi runs on [Appwrite Cloud](https://cloud.appwrite.io), and is an opt-in service for self-hosted Appwrite. Appwrite owns everything around a review: the GitHub App and its webhooks, which project reviews a repository, accounts, billing and the Console. Hansi owns everything between "review pull request #N at commit X" and the review on GitHub.

Table of Contents:

- [Features](#features)
- [Getting Started](#getting-started)
  - [Repository settings](#repository-settings)
- [Self-Hosting](#self-hosting)
  - [Environment variables](#environment-variables)
  - [Running in a cluster](#running-in-a-cluster)
- [Architecture](#architecture)
- [Development](#development)
- [Contributing](#contributing)
- [Security](#security)
- [License](#license)

## Features

- **Reviews that read the code** - An agent checks out the pull request and reads the repository with `git` and `ripgrep`, not only the diff, so a finding can point at the caller it breaks.
- **Verified findings** - A second pass verifies every finding against the code before anything is posted. Findings are placed on lines the diff can actually comment on.
- **Commands in a sandbox** - With an [open-runtimes orchestrator](https://github.com/open-runtimes/orchestrator), the agents can run tests, type checkers and short scripts in an isolated sandbox of the pull request head. Nothing from a reviewed repository runs in the Hansi container.
- **Decisions made by code** - The model proposes a merge-confidence tier; open findings cap it, and whether to approve or request changes is decided by the code, never by the model.
- **Chat on pull requests** - Mention Hansi on a pull request or in a review thread, or reply to one of its findings, and it answers once, with the same read-only tools as a review.
- **Configurable per repository** - A `.hansi.json` file on the base branch sets the profile, paths, severity thresholds and extra instructions. A pull request cannot change how it is reviewed.
- **Built on Appwrite's queue** - Jobs are read with [utopia-php/queue](https://github.com/utopia-php/queue), the same way Appwrite's own workers read a queue, so attempts, backoff and dead letters behave the same.

## Getting Started

On Appwrite Cloud, open your project in the [Console](https://cloud.appwrite.io), go to **Review**, and connect a GitHub repository. New pull requests and pushes to them are reviewed from then on.

### Repository settings

Every setting is optional. Add a `.hansi.json` to the base branch to change them, since it is read from there; a file that does not parse falls back to the defaults and the review says why.

```json
{
	"reviews": {
		"profile": "balanced",
		"paths": ["src/**", "!src/generated/**"],
		"minSeverity": "minor",
		"requestChanges": "major"
	},
	"instructions": "We target Node 22. Flag any use of synchronous filesystem APIs.",
	"pathInstructions": [
		{ "path": "migrations/**", "instructions": "Migrations must be reversible." }
	],
	"sandbox": { "setup": "npm ci" }
}
```

| Setting                              | Default    | Description                                                                                                                           |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `reviews.enabled`                    | `true`     | Review pull requests in this repository. Chat follows this too.                                                                       |
| `reviews.auto`                       | `true`     | Review when a pull request is opened or pushed to. Mentions work either way.                                                          |
| `reviews.drafts`                     | `false`    | Review draft pull requests too.                                                                                                       |
| `reviews.baseBranches`               | `[]`       | Only review pull requests into these branches. Empty means every branch.                                                              |
| `reviews.paths`                      | `[]`       | Globs of files to review. A leading `!` excludes, e.g. `"!docs/**"`.                                                                  |
| `reviews.profile`                    | `balanced` | `chill` reports only bugs it can show; `balanced` adds risky patterns, weak tests and broken docs; `strict` adds naming and style.    |
| `reviews.minSeverity`                | `minor`    | Findings below this severity (`info`, `minor`, `major`, `critical`) are not posted.                                                   |
| `reviews.maxComments`                | `15`       | The most inline comments one review posts, up to 100.                                                                                 |
| `reviews.approve`                    | `true`     | Approve pull requests with nothing blocking and no open defect.                                                                       |
| `reviews.requestChanges`             | `major`    | Findings at or above this severity request changes. `never` only comments, and still never approves over a major or critical finding. |
| `reviews.approveOutsideContributors` | `false`    | Approve pull requests from authors without write access. Off by default: their code could try to talk the model into an approval.     |
| `instructions`                       | `""`       | Extra review instructions, in plain language.                                                                                         |
| `pathInstructions`                   | `[]`       | Instructions for files matching a glob.                                                                                               |
| `language`                           | `en`       | Language of review comments.                                                                                                          |
| `sandbox.setup`                      | `""`       | Shell command run when a review first runs a command, e.g. `npm ci`. The sandbox reaches public hosts.                                |

## Self-Hosting

On a self-hosted Appwrite, Hansi is an optional container next to Appwrite's own. Appwrite publishes review jobs only when reviews are turned on; Hansi reads them from Appwrite's Redis and reports back over Appwrite's internal API, authenticated with the secret Appwrite sets as `_APP_REVIEWS_SECRET`.

Add the service to your Appwrite `docker-compose.yml`, on the same network as the `appwrite` and `redis` containers:

```yaml
services:
  hansi:
    image: ghcr.io/appwrite/hansi:main
    container_name: appwrite-hansi
    restart: unless-stopped
    stop_grace_period: 15m
    networks:
      - appwrite
    depends_on:
      - appwrite
      - redis
    environment:
      - HANSI_APPWRITE_ENDPOINT=http://appwrite/v1
      - HANSI_APPWRITE_SECRET=${_APP_REVIEWS_SECRET}
      - HANSI_QUEUE_URL=redis://redis:6379
      - HANSI_REVIEW_MODEL
      - AI_GATEWAY_API_KEY
```

Then start it with `docker compose up -d hansi`. Without an orchestrator, as above, reviews read the code with the same tools but cannot run commands, and the agents are not offered `run_command`. To let them run commands, point `HANSI_ORCHESTRATOR_ENDPOINT` at an [open-runtimes orchestrator](https://github.com/open-runtimes/orchestrator) and set `HANSI_SANDBOX_IMAGE`.

Images are published to `ghcr.io/appwrite/hansi` for amd64 and arm64: `main` and `sha-<commit>` from every push to `main`, and a version tag for every release.

### Environment variables

The service validates its environment on start (`apps/service/src/env.ts`) and exits with the reason when something is missing. The `HANSI_QUEUE_*` variables are read by the queue consumer (`apps/consumer/consumer.php`).

| Variable                      | Default      | Description                                                                                |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `HANSI_APPWRITE_ENDPOINT`     | **required** | Appwrite's internal API, e.g. `http://appwrite/v1`. Never the public endpoint.             |
| `HANSI_APPWRITE_SECRET`       | **required** | The `_APP_REVIEWS_SECRET` of that Appwrite.                                                |
| `HANSI_QUEUE_URL`             | **required** | Appwrite's queue: `redis://` on self-hosted, `nats://` on Cloud.                           |
| `HANSI_QUEUE_NAME`            | `v1-reviews` | The queue Appwrite publishes review jobs to.                                               |
| `HANSI_QUEUE_USER`            |              | Queue user, instead of in the URL.                                                         |
| `HANSI_QUEUE_PASSWORD`        |              | Queue password, instead of in the URL.                                                     |
| `HANSI_REVIEW_MODEL`          | **required** | [AI SDK](https://ai-sdk.dev) model id for the reviewer, as `provider/model`.               |
| `HANSI_VERIFY_MODEL`          | review model | AI SDK model id for the verifier.                                                          |
| `AI_GATEWAY_API_KEY`          |              | Key for the AI Gateway, the AI SDK's default provider for model ids.                       |
| `HANSI_ORCHESTRATOR_ENDPOINT` |              | open-runtimes orchestrator API. Without it, reviews only read the code.                    |
| `HANSI_ORCHESTRATOR_KEY`      |              | Orchestrator API key, when it has one.                                                     |
| `HANSI_SANDBOX_IMAGE`         |              | Toolchain image for sandboxes. Required with an orchestrator.                              |
| `HANSI_CONCURRENCY`           | `4`          | Jobs one container runs at once. Each holds a checkout, and a sandbox if it runs commands. |
| `HANSI_PORT`                  | `8080`       | Port for `/healthz` and `/readyz`.                                                         |
| `HANSI_JOBS_PORT`             | `8081`       | Loopback port where the consumer hands over jobs.                                          |
| `HANSI_SHUTDOWN_TIMEOUT`      | `3600`       | Seconds a stopping consumer waits for running jobs.                                        |
| `HANSI_CONSUMER_COMMAND`      | set by image | Starts the queue consumer. Unset, jobs only arrive from whoever calls the jobs port.       |
| `HANSI_LOG_LEVEL`             | `info`       | `debug`, `info`, `warn` or `error`.                                                        |

Model ids go through the AI SDK's global provider, the AI Gateway unless configured otherwise. This is a stopgap until Appwrite serves model keys and models itself.

On Redis, which counts no deliveries, the consumer gives a job 3 attempts, 10 s, 60 s and 5 min apart. On NATS the attempts and backoff are the ones Appwrite provisioned on the queue's work consumer.

### Running in a cluster

The image runs as the unprivileged `hansi` user with a read-only root filesystem in mind. In a cluster it needs:

- The environment above, with credentials from a Secret.
- A writable `/tmp` for checkouts.
- Liveness on `/healthz` and readiness on `/readyz`, port 8080. Readiness drops as soon as shutdown starts.
- No Service: Hansi pulls jobs, nothing connects to it.
- A termination grace period long enough for running jobs to finish (a repository's setup command alone may take 15 minutes), with `HANSI_SHUTDOWN_TIMEOUT` below it.

## Architecture

```
GitHub ─► Appwrite (webhooks, Review) ─► queue ─► Hansi
             ▲                                     │ installation token
             └────── results, usage, trace ◄───────┤ review on GitHub
                                                   └─► orchestrator sandbox
```

1. Appwrite receives a GitHub webhook for a repository with reviews turned on and publishes a job to its reviews queue: NATS JetStream on Cloud, Redis on self-hosted.
2. The consumer, a PHP process on utopia-php/queue started by the service as its child, hands each delivery to the service over loopback and settles it by the outcome the service answers with.
3. The service asks Appwrite for a repository-scoped installation token, checks out the pull request, and runs the review: an agent loop on the [Vercel AI SDK](https://ai-sdk.dev), then a verify pass.
4. The review is posted to GitHub with inline comments and a check run, and the results, model usage and trace go back to Appwrite. Calls that hit Appwrite's abuse limit are sent again once it resets.

The container runs and stops as one: Bun is PID 1, and on `SIGTERM` it stops the consumer, which stops receiving and settles what it holds once the jobs it handed over finish.

| Path                | Description                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `apps/service`      | The process: environment, logger, health server, the jobs port, and the worker that runs jobs and decides retries. |
| `apps/consumer`     | The queue consumer in PHP, on `Broker\Nats` (Cloud) or `Broker\Redis` (self-hosted).                               |
| `packages/engine`   | The review and chat: the agent loop, its tools, the prompts, and placing, verifying and grading findings.          |
| `packages/appwrite` | Appwrite adapters: the results sink, installation tokens and job payload parsing.                                  |
| `packages/github`   | GitHub client over REST and GraphQL, with installation tokens from Appwrite renewed before they expire.            |
| `packages/sandbox`  | Sandboxes on the open-runtimes orchestrator, for the agents' `run_command`.                                        |

The engine depends only on its contracts (`GitHubClient`, `SandboxClient`, `ResultsSink`); adapters depend on the engine, never the other way round.

## Development

You need [Bun](https://bun.sh) 1.4, plus `git` and [ripgrep](https://github.com/BurntSushi/ripgrep) on the path, which the review's tools run in tests too.

```sh
bun install
bun run test     # all tests
bun run check    # type-check every workspace
bun run lint     # Prettier and ESLint
bun run format   # apply Prettier
bun run dev      # run the service with reload
```

Tests use in-memory fakes and a scripted model from `@hansi/engine/testing`, and never call a real model, GitHub or Appwrite.

The consumer runs on PHP 8.5 with Swoole. Without a local PHP 8.5, run its tests in the image it ships on:

```sh
docker run --rm -v "$PWD/apps/consumer:/app" -w /app appwrite/base:2.2.7 \
  sh -c 'composer install && vendor/bin/phpunit tests'
```

To build and run the image locally:

```sh
docker build -t hansi .
```

## Contributing

All code contributions, including those of people having commit access, must go through a pull request and be approved by a core developer before being merged. This is to ensure a proper review of all the code.

We truly ❤️ pull requests! If you wish to help, you can learn more about how you can contribute in the [Appwrite contribution guide](https://github.com/appwrite/appwrite/blob/main/CONTRIBUTING.md). Run `bun run format`, `bun run lint`, `bun run check` and `bun run test` before you push; CI runs the last three, the consumer's tests and an image smoke test.

## Security

Please **do not** report security vulnerabilities through public GitHub issues, discussions, or pull requests. Report them privately through [GitHub private vulnerability reporting](https://github.com/appwrite/hansi/security/advisories/new) or by email to [security@appwrite.io](mailto:security@appwrite.io).

Whatever a review touches is treated as untrusted: file contents, pull request text, comments and command output. No credential reaches a sandbox's environment or the logs, and a sandbox's URL is a capability that is never logged.

## License

This repository is available under the [BSD 3-Clause License](./LICENSE).
