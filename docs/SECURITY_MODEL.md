# Security Model

## Default Posture

Analysis is **read-only by default**. Copilot Architect does not modify a target repository unless a command explicitly requires it and the user has approved the action.

**Telemetry is disabled by default.** The MVP is local-first: repo analysis, indexes, plans, handoffs, validation logs, review reports, policy files, and audit logs stay under the local workspace unless a user intentionally moves or shares them.

---

## Workspace Boundary

Runtime artifacts must be written under `.copilot-architect/` inside the repo or workspace root unless explicitly configured otherwise. The tool never writes outside the repo/workspace root without explicit permission. The `PathBoundaryService` enforces this for all validation commands.

---

## Dangerous Commands

The safety policy blocks dangerous commands by default through `CommandRiskAssessmentService`. Blocked commands produce an actionable safety result rather than running.

**Blocked by default:**

| Command                             | Pattern                                |
| ----------------------------------- | -------------------------------------- |
| `rm -rf` / `rm -rf /`               | `\brm\s+-[^\s]*(?:r[^\s]*f\|f[^\s]*r)` |
| `del /s` (Windows)                  | `\bdel\s+\/s\b`                        |
| `format` disk utility               | `^(?:format\|format\.com)(?:\s\|$)`    |
| `diskpart`                          | `\bdiskpart\b`                         |
| `git clean -fdx`                    | All three flags required               |
| `git reset --hard`                  | `\bgit\s+reset\s+--hard\b`             |
| `chmod -R 777`                      | `\bchmod\s+-r\s+777\b`                 |
| `sudo rm`                           | `\bsudo\s+rm\b`                        |
| `Remove-Item -Recurse` (PowerShell) | `\bRemove-Item\s+-Recurse\b`           |

**Git history mutations** (logged as warnings, not blocked by default unless policy is set):

- `git push --force`
- `git rebase`
- `git reset --hard`
- `git clean -f`

---

## Secret Redaction

All logs, audit entries, validation reports, review reports, and handoff prompts are processed through `SecretRedactionService` before being written to disk. The following patterns are redacted:

| Category                    | Example                                                                     |
| --------------------------- | --------------------------------------------------------------------------- |
| Env-var assignments         | `TOKEN=abc123` → `TOKEN=[REDACTED]`                                         |
| Extended env-var keywords   | `CLIENT_SECRET`, `SIGNING_KEY`, `ENCRYPTION_KEY`, `PRIVATE_KEY`, `AUTH_KEY` |
| HTTP Bearer tokens          | `Authorization: Bearer eyJ…`                                                |
| GitHub tokens               | `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…`                                 |
| AWS access key IDs          | `AKIAIOSFODNN7EXAMPLE` → `[REDACTED_AWS_KEY_ID]`                            |
| AWS secret access keys      | 40-char base64 strings after `AWS_SECRET_ACCESS_KEY=`                       |
| GCP API keys                | `AIza…` (35-char suffix)                                                    |
| Stripe secret keys          | `sk_live_…`, `sk_test_…`                                                    |
| Stripe publishable keys     | `pk_live_…`, `pk_test_…`                                                    |
| Stripe restricted keys      | `rk_live_…`, `rk_test_…`                                                    |
| PEM private key blocks      | `-----BEGIN RSA PRIVATE KEY-----`                                           |
| JWT tokens                  | Three-part base64url tokens                                                 |
| Database connection strings | `postgres://user:password@host/db` — credentials redacted                   |
| npm auth tokens             | `_authToken=…`, `npm_token=…`                                               |
| Slack tokens                | `xoxb-…`, `xoxp-…`, `xoxs-…`, `xoxa-…`                                      |

Custom secret patterns can be added to `.copilot-architect/policy.json` under `secretRedactionPatterns`.

---

## Human Approval Gates

Implementation handoff **always requires `--approve`**:

```bash
npm run cli -- handoff --plan latest --approve
```

Copilot Architect may generate plans and prompts, but it never claims that implementation has been approved or completed unless the user explicitly runs the approval command. The safety policy lists required approval gates in `.copilot-architect/policy.json`:

```json
"requiredApprovalGates": [
  "planning",
  "handoff",
  "validation-risk",
  "agent-install",
  "policy-change"
]
```

---

## Audit Logs

Audit entries are written to `.copilot-architect/audit/audit.jsonl` on every mutating action. Each entry records:

- Timestamp
- Actor (CLI, MCP, VS Code, or web)
- Action name
- Summary (with secrets redacted)
- Metadata (with secrets redacted)
- Artifact paths affected
- Redactions applied

Audit logs are **append-only** and excluded from default retention cleanup to preserve compliance evidence.

---

## Artifact Retention and Cleanup

`.copilot-architect/policy.json` controls artifact retention. Cleanup is **dry-run by default**:

```bash
npm run cli -- cleanup --dry-run           # preview eligible artifacts
npm run cli -- cleanup --apply             # delete eligible artifacts
npm run cli -- cleanup --max-age-days 14   # custom age limit
npm run cli -- cleanup --max-runs 20       # custom run count limit
```

Rules:

- Only files under `.copilot-architect/` in the configured directories are eligible.
- `latest-*` alias files are always preserved.
- The audit log is never cleaned by default retention.
- Each cleanup run writes a redacted audit entry.

---

## Trust Metadata

Generated policy, agent, and instruction artifacts include `trustMetadata` fields:

```json
{
  "generatedBy": "copilot-architect@0.1.1",
  "artifactKind": "agent",
  "localOnly": true,
  "telemetryEnabled": false,
  "policyId": "default-safety-policy"
}
```

This metadata is informational for internal review and does not grant execution permission by itself.

---

## UI Safety

VS Code and web UI shells call the same validator and policy engine used by the CLI and MCP server. UI shells must never bypass safety policy or implement safety logic directly.

---

## Local-First Guarantee

- No data is sent to any cloud service by Copilot Architect itself.
- MCP tools read and write the same `.copilot-architect/` artifacts as the CLI.
- The `localFirst: true` policy field is validated on every `policy validate` run.
- Telemetry is disabled by default and must be explicitly opted into in `policy.json`.
