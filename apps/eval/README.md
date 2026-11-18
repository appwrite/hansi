# Eval

Replays pull requests with known problems through a real review and scores what Hansi finds, so a model, prompt or strength change comes with numbers instead of impressions.

Each case is a pull request and what a good review of it reports. A run reviews every case with the service's own models and engine (no GitHub, no Appwrite: the review is never posted), matches the posted findings to the expected ones, and writes a report.

```sh
export HANSI_REVIEW_MODEL=bedrock:global.anthropic.claude-sonnet-4-5-20250929-v1:0
export HANSI_AI_SECRET=… HANSI_AI_REGION=eu-central-1
bun run eval --runs 3
bun run eval --strength basic --runs 3 --compare results/<earlier>.json
```

Models come from the same variables as the service (`HANSI_REVIEW_MODEL`, `HANSI_VERIFY_MODEL`, the `HANSI_BASIC_*` and `HANSI_EXPERT_*` models, the reasoning efforts and `HANSI_AI_*`), so a run reviews with what production would at that strength. With `HANSI_ORCHESTRATOR_ENDPOINT` and `HANSI_SANDBOX_IMAGE`, normal and expert reviews run commands in a sandbox as they do in production; without them they only read the code, and the report says so. `GITHUB_TOKEN` is used to clone private repositories. `bun run eval --help` lists the options.

## What the report says

| Metric                    | Meaning                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Recall                    | Expected problems a posted finding reported, out of all expected problems.                                             |
| Precision (vs labels)     | Posted findings that reported an expected problem, out of all posted on cases with problems. Labels can be incomplete. |
| False alarms on clean PRs | Reviews of clean cases that posted any finding.                                                                        |
| Verdict accuracy          | Reviews that reached the case's expected verdict.                                                                      |
| Real problems dropped     | Expected problems a finding reported, but the verifier or a filter then dropped.                                       |
| Cost, time, commands      | Per review. Cost uses models.dev's list prices, as the service's metrics do.                                           |

Models are not deterministic, so use `--runs 3` or more before reading anything into a difference. The JSON report in `results/` (not committed) keeps every run's findings, so an extra finding can be read to see whether it is a real problem the case does not list.

A finding counts for an expected problem when it is on the same file, at the problem's severity or above, and within `--tolerance` lines of it (5 by default). With `--judge`, a model decides instead, among every finding on the file: slower and costs a little, but it does not count a different problem on the same line, and it does count the right problem reported on a caller. `HANSI_JUDGE_MODEL` picks the judge's model, the verify model by default.

## Adding a case

A case is a directory under `cases/` with a `case.json`:

```json
{
	"description": "Real bug: … Fixed later in <sha>.",
	"source": "https://github.com/appwrite/hansi/commit/<sha>",
	"repo": "appwrite/hansi",
	"pull": 27,
	"base": "<40-character sha>",
	"head": "<40-character sha>",
	"pullRequest": { "title": "…", "body": "…" },
	"expected": {
		"verdict": "request_changes",
		"findings": [
			{
				"id": "short-name",
				"path": "src/file.ts",
				"lines": [10, 12],
				"issue": "What is wrong and what it breaks, in a sentence or two.",
				"severity": "major"
			}
		]
	}
}
```

- `repo` is `owner/name` on GitHub or a clone URL. With `pull`, the head is fetched from the pull request's ref, so heads on forks work; without it, the head commit is fetched by its SHA.
- `lines` are lines of the file at the head, after any patch. `severity` is the least a finding needs to count; leave it out to count any.
- `config` takes the repository settings as in `.hansi.json`. Leave it out to read `.hansi.json` from the base commit, as a review does.
- `linkedIssues` takes `{ number, title, body }` entries, as a review gets them from the pull request.
- An empty `findings` list makes a clean case: a good review posts nothing and approves.

There are three kinds of cases, and the set needs all three:

- **Real bugs**: a pull request that shipped a bug a later commit fixed. Base and head are that pull request's; the expected finding is the bug the fix names.
- **Clean**: a pull request that needed nothing, such as the fix itself. These measure false alarms.
- **Planted**: a real pull request with an `inject.patch` beside `case.json`, applied on top of the head as one more commit. It plants a known bug without pushing anything anywhere. Make it with `git diff` in a checkout of the head.

Run a new case on its own first (`bun run eval --case <id>`) and read the review: a case whose expected problem no reasonable reviewer would see from the pull request measures nothing.
