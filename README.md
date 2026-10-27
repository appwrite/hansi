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

Work in progress. The service runs the worker loop and serves health checks. A review job fetches the pull request, checks it out, runs the review and verify pass, and posts the review with inline comments and a check run. Jobs come from Appwrite's reviews queue on NATS JetStream, read the way Appwrite's own workers read a queue. The other Appwrite adapters (results, installation tokens) are stubs until the Reviews module lands in appwrite/appwrite; chat and the sandbox tool follow in later changes.

## Development

```sh
bun install
bun run test
```

The service reads its configuration from the environment:

| Variable                      | Default      |                                               |
| ----------------------------- | ------------ | --------------------------------------------- |
| `HANSI_APPWRITE_ENDPOINT`     |              | Appwrite internal API                         |
| `HANSI_APPWRITE_SECRET`       |              | Shared secret for that API                    |
| `HANSI_QUEUE_URL`             |              | Appwrite's NATS, `nats://user:pass@host:4222` |
| `HANSI_QUEUE_NAME`            | `v1-reviews` | Queue the Reviews module publishes to         |
| `HANSI_ORCHESTRATOR_ENDPOINT` |              | open-runtimes orchestrator API                |
| `HANSI_ORCHESTRATOR_KEY`      |              | Orchestrator API key, when it has one         |
| `HANSI_SANDBOX_IMAGE`         |              | Toolchain image for sandboxes                 |
| `HANSI_REVIEW_MODEL`          |              | AI SDK model id for the reviewer              |
| `HANSI_VERIFY_MODEL`          | review model | AI SDK model id for the verifier              |
| `HANSI_CONCURRENCY`           | `4`          | Jobs one process runs at once                 |
| `HANSI_PORT`                  | `8080`       | `/healthz` and `/readyz`                      |
| `HANSI_LOG_LEVEL`             | `info`       | `debug`, `info`, `warn`, `error`              |

Model ids go through the AI SDK's global provider, the AI Gateway unless configured otherwise, which reads `AI_GATEWAY_API_KEY`. This is a stopgap until Appwrite serves the keys and models.
