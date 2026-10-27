# Hansi

AI code review for Appwrite Cloud.

Appwrite receives GitHub webhooks for repositories that have code review turned on and queues a job. This service picks the job up, checks out the pull request, reviews it with an agent that reads the code and can run commands in an isolated sandbox, then posts the review to GitHub and the results to Appwrite.

```
GitHub ─► Appwrite (webhooks, Reviews module) ─► queue ─► hansi service
                ▲                                              │ installation token
                └──────── results, usage, trace ◄──────────────┤ review on GitHub
                                                               └─► orchestrator sandbox
```

## Status

Skeleton. The service starts, runs the worker loop and serves health checks, and the engine contracts are in place. The Appwrite adapters are stubs until the Reviews module lands in appwrite/appwrite, The engine can run a review and verify pass against a local checkout; fetching the pull request, posting to GitHub and the sandbox tool follow in later changes.

## Development

```sh
bun install
bun run test
```

The service reads its configuration from the environment:

| Variable                      | Default      |                                       |
| ----------------------------- | ------------ | ------------------------------------- |
| `HANSI_APPWRITE_ENDPOINT`     |              | Appwrite internal API                 |
| `HANSI_APPWRITE_SECRET`       |              | Shared secret for that API            |
| `HANSI_APPWRITE_QUEUE`        | `v1-reviews` | Queue the Reviews module publishes to |
| `HANSI_ORCHESTRATOR_ENDPOINT` |              | open-runtimes orchestrator API        |
| `HANSI_ORCHESTRATOR_KEY`      |              | Orchestrator API key, when it has one |
| `HANSI_SANDBOX_IMAGE`         |              | Toolchain image for sandboxes         |
| `HANSI_CONCURRENCY`           | `4`          | Jobs one process runs at once         |
| `HANSI_PORT`                  | `8080`       | `/healthz` and `/readyz`              |
| `HANSI_LOG_LEVEL`             | `info`       | `debug`, `info`, `warn`, `error`      |
