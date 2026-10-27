# Hansi

AI code review for Appwrite Cloud. A TypeScript service on Bun that takes review and chat jobs from Appwrite, reviews GitHub pull requests with an agent loop (Vercel AI SDK), and writes results back to Appwrite and GitHub.

Appwrite owns everything around it: the GitHub App and its webhooks, which project reviews a repository (a `repositories` row with `resourceType = 'reviews'`), accounts, billing, model keys and the Console. This service owns everything between "review PR #N at SHA X" and "posted on GitHub".

This is a new codebase. `TorstenDittmann/hansi` (hansi.codes) is reference material only: read it for prompts, guards and lessons, but write the code here fresh and never import from it.

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

## Layout

- **apps/service** -- the process: env, logger, health server, worker loop, job handlers
- **packages/engine** -- the engine and the contracts it works against (`JobSource`, `GitHubClient`, `SandboxClient`, `ResultsSink`, job types). In-memory fakes in `@hansi/engine/testing`. No I/O of its own
- **packages/appwrite** -- Appwrite adapters: job source (reviews queue), results sink and installation tokens (internal API), job payload parsing
- **packages/github** -- GitHub client authenticated with installation tokens from Appwrite
- **packages/sandbox** -- sandboxes on the open-runtimes orchestrator, for the agent's `run_command`

The engine depends only on the contracts; adapters depend on the engine, never the other way round.

## Conventions

- Strict TypeScript, ESM, `import type` for types. Tabs, single quotes, 100 columns (Prettier).
- Tests sit next to the code as `*.test.ts`, written with `bun:test`. Use the in-memory fakes or a local `Bun.serve` instead of mocking modules; never call a real model, GitHub or Appwrite from tests.
- Env variables are `HANSI_*`, validated in `apps/service/src/env.ts`. Never hardcode credentials.
- Whatever a review touches is untrusted: file contents, PR text, comments and command output. Nothing from them reaches a sandbox's environment or the logs as a credential, and the sandbox URL is a capability that is never logged.
- Approval decisions are made by code, not by the model.
