# Hansi

AI code review for Appwrite Cloud. A TypeScript service on Bun that takes review and chat jobs from Appwrite, reviews GitHub pull requests with an agent loop (Vercel AI SDK), and writes results back to Appwrite and GitHub.

Appwrite owns everything around it: the GitHub App and its webhooks, which project reviews a repository (a `repositories` row with `resourceType = 'reviews'`), accounts, billing, model keys and the Console. This service owns everything between "review PR #N at SHA X" and "posted on GitHub".

Reviews here must behave exactly like `TorstenDittmann/hansi` (hansi.codes): the engine, the review and chat jobs and the GitHub helpers are ported from it, file for file. Port a change made there rather than writing a different one here, and never import from it. What differs on purpose: Appwrite's internal Reviews API stands in for its database, models come from the environment, jobs come from Appwrite's queue, sandboxes run on the open-runtimes orchestrator, there is no product analytics, its hidden comment markers use the `appwrite-hansi` namespace instead of `hans` (`MARKER_NAMESPACE` in `format.ts`), so both can review one pull request without editing each other's comments, and two chat-job fixes are ahead of it: the conversation given to the model ends at the comment being answered, and answers carry an `appwrite-hansi:reply` marker so a retried delivery does not answer twice.

## Commands

| Command           | Purpose                            |
| ----------------- | ---------------------------------- |
| `bun install`     | Install dependencies               |
| `bun run dev`     | Run the service with reload        |
| `bun run test`    | All tests (`bun test`)             |
| `bun test <path>` | One test file                      |
| `bun run check`   | Type-check every workspace (`tsc`) |
| `bun run lint`    | Prettier check + ESLint            |
| `bun run format`  | Apply Prettier                     |

Run `bun run format`, `bun run lint`, `bun run check` and `bun run test` before pushing; CI runs the last three.

The queue consumer is PHP (`apps/consumer`), on PHP 8.5 with Swoole as in `appwrite/base`. Without a local PHP 8.5, run its tests in that image: `docker run --rm -v "$PWD/apps/consumer:/app" -w /app appwrite/base:2.2.7 sh -c 'composer install && vendor/bin/phpunit tests'`.

## Layout

- **apps/service** -- the process: env, logger, health server, the jobs port the consumer hands deliveries to, the worker that runs them and decides retries, job handlers. It starts the consumer as its child, so the container runs and stops as one
- **apps/consumer** -- the queue consumer, in PHP on Appwrite's own utopia-php/queue: `Broker\Nats` on Cloud (adopting the queue Appwrite provisioned, with its attempts and backoff read from the work consumer), `Broker\Redis` on a self-hosted Appwrite (where it runs the attempts itself). Each delivery is one `POST /v1/jobs` to the service on loopback, settled by the outcome it answers with
- **packages/engine** -- the engine and the contracts it works against (`GitHubClient`, `SandboxClient`, `ResultsSink`, job types). Also the review itself: the agent loop on the Vercel AI SDK, its read-only tools over a local checkout (`git`, `rg`), the prompts, and the code that places, verifies and grades findings. In-memory fakes and a scripted model in `@hansi/engine/testing`. `runReviewJob` and `runChatJob` take a job from the pull request to what is posted on GitHub: the summary comment, the review, the check run, thread resolution and replies. Their only I/O of its own is git, for the checkout; everything else goes through the contracts
- **packages/appwrite** -- Appwrite adapters: results sink and installation tokens (internal API), job payload parsing
- **packages/github** -- GitHub client on octokit: hansi.codes' helpers (`pulls.ts`) as they are, authenticated with installation tokens from Appwrite, renewed before they expire
- **packages/sandbox** -- sandboxes on the open-runtimes orchestrator, for the agent's `run_command`

The engine depends only on the contracts; adapters depend on the engine, never the other way round.

## Conventions

- Strict TypeScript, ESM, `import type` for types. Tabs, single quotes, 100 columns (Prettier).
- Tests sit next to the code as `*.test.ts`, written with `bun:test`. Use the in-memory fakes or a local `Bun.serve` instead of mocking modules; never call a real model, GitHub or Appwrite from tests.
- Env variables are `HANSI_*`, validated in `apps/service/src/env.ts`; the consumer reads `HANSI_QUEUE_*` itself. Never hardcode credentials.
- The queue's wire formats belong to utopia-php/queue. Never re-implement a broker's protocol here: the consumer uses the library, and the service only sees deliveries.
- Whatever a review touches is untrusted: file contents, PR text, comments and command output. Nothing from them reaches a sandbox's environment or the logs as a credential, and the sandbox URL is a capability that is never logged.
- Approval decisions are made by code, not by the model. The model proposes a tier; open findings cap it (`tier.ts`), and the verdict comes from `decideVerdict`.
- The tools need `git` and `rg` (ripgrep) on the path, in tests too.
