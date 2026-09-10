# Automated review providers

The review-request tool accepts only the providers and modes in this table. The probe reports `observed` only from a provider check, review, review comment, or issue comment. `unknown` means the repository data does not prove whether the integration is installed.

| Provider | Request | Probe identity | Availability rule |
|---|---|---|---|
| Codex | `provider=codex`, `mode=review` posts `@codex review` | `chatgpt-codex-connector` | The repository must have Code review enabled. Automatic reviews may remain disabled. |
| CodeRabbit | `provider=coderabbit`, `mode=incremental` posts `@coderabbitai review`; `mode=full` posts `@coderabbitai full review` | `coderabbitai` | Each command consumes the provider's configured review allowance. |
| GitHub Copilot | `provider=copilot`, `mode=review` requests `copilot-pull-request-reviewer[bot]` through GitHub's requested-reviewers endpoint | `copilot-pull-request-reviewer` | Endpoint acceptance proves the reviewer is requestable for that PR. |
| Gemini Code Assist | `provider=gemini`, `mode=review` posts `/gemini review` | `gemini-code-assist` | A provider response or review proves observation. |
| Qodo | no request mode | `qodo-merge` or `qodo-merge-pro` | Observe only. Current Code Review documentation does not publish a manual trigger. |
| Greptile | `provider=greptile`, `mode=review` posts `@greptileai` | `greptile-apps` | A provider response or review proves observation. |

The tool checks the exact PR head before every mutation. Comment requests contain a hidden provider, mode, and head marker. Only a marker authored by the active GitHub identity deduplicates a request after restart. The marker check is not an atomic lock. The architect's sole PR-update ownership serializes request calls. Copilot deduplication reads requested reviewers and exact-head reviews.

Use `metadata.bot_review_requests` as a provider-to-mode object, for example `{"codex":"review","coderabbit":"full"}`. An empty object requests no manual reviews. Include a provider only when the originating request, repository policy, or a recorded material-risk decision requires that second opinion. The architect alone invokes the request tool while retaining sole PR-update ownership.

A manual request does not prove availability. The architect records `requested` or `already_requested` evidence before shepherd handoff. The shepherd reads the probe's exact-head marker and provider result. Treat `pending`, `stale`, or `absent` as IDLE for ten minutes from `requestedAt`. After ten minutes without provider evidence, record BLOCKED with the request URL and provider. Missing markers or timestamps are BLOCKED.

Provider commands and plan limits can change. Verify an adapter against the provider's official documentation before changing its command:

- Codex: https://developers.openai.com/codex/integrations/github
- CodeRabbit: https://docs.coderabbit.ai/reference/review-commands
- GitHub Copilot: https://docs.github.com/en/copilot/using-github-copilot/code-review/using-copilot-code-review
- Gemini Code Assist: https://docs.cloud.google.com/gemini/docs/code-review/use-code-assist-github
- Greptile: https://www.greptile.com/docs/code-review-bot/trigger-code-review
