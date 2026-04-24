# Databricks Asset Bundle Support

CatalystOps detects `databricks.yml` in your workspace root and provides a sidebar panel, inline YAML linting, and a connection wizard shortcut for Databricks Asset Bundle (DAB) projects.

## Bundle Tasks Panel

Open the **Bundle Tasks** view in the CatalystOps sidebar. It lists every task found across `databricks.yml` and all files referenced by `include:` patterns:

- `spark_python_task` entries show the Python file path
- `notebook_task` entries with local paths show the notebook path
- Click any task to open its source file in the editor
- Use the inline **Analyze** button to run a dry-run plan analysis on that task's script

The panel refreshes automatically whenever `databricks.yml` or any included resource YAML changes.

## YAML Linting

CatalystOps validates bundle YAML inline as you type. Diagnostics appear as underlines directly in the editor.

### Key / Structure Checks

| Rule | Severity |
|------|----------|
| Unknown top-level keys (only `bundle`, `include`, `variables`, `resources`, `targets`, etc.) | Warning |
| Unknown resource types under `resources:` | Warning |
| Include patterns that match no files | Warning |

### Enum Validation

| Field | Valid Values |
|-------|-------------|
| `data_security_mode` | `SINGLE_USER`, `USER_ISOLATION`, `NONE`, `LEGACY_*` |
| `runtime_engine` | `PHOTON`, `STANDARD` |
| `pause_status` | `PAUSED`, `UNPAUSED` |
| `target.mode` | `development`, `production` |
| `run_if` (task) | `ALL_SUCCESS`, `ALL_DONE`, `NONE_FAILED`, `AT_LEAST_ONE_SUCCESS`, `ALL_FAILED`, `AT_LEAST_ONE_FAILED` |
| `trigger.periodic.unit` | `HOURS`, `DAYS`, `WEEKS` |
| `health.rules[].metric` | `RUN_DURATION_SECONDS`, `STREAMING_BACKLOG_SECONDS`, `STREAMING_BACKLOG_RECORDS` |
| `health.rules[].op` | `GREATER_THAN` |
| Permission `level` (job) | `CAN_VIEW`, `CAN_MANAGE_RUN`, `CAN_MANAGE` |
| Permission `level` (dashboard/alert) | `CAN_READ`, `CAN_RUN`, `CAN_EDIT`, `CAN_MANAGE` |

### Alert v2 Schema Checks

The Databricks Alert v2 API schema differs from other resources. CatalystOps catches these common mistakes:

| Mistake | Correct form |
|---------|-------------|
| `condition:` key | Use `evaluation:` |
| `subscriptions:` at alert level | Move under `evaluation.notification.subscriptions` |
| `schedule.cron_schedule:` | Use `schedule.quartz_cron_schedule:` |
| Missing `schedule.pause_status` | Required field |
| Invalid `comparison_operator` | `EQUAL`, `NOT_EQUAL`, `GREATER_THAN`, `GREATER_THAN_OR_EQUAL`, `LESS_THAN`, `LESS_THAN_OR_EQUAL` |

### Volume Permissions

Volumes use `grants:` not `permissions:`. CatalystOps errors if `permissions:` is found on a volume resource.

### Mutual Exclusions

| Conflict | Error |
|----------|-------|
| `schedule:` + `continuous:` on same job | Error |
| `job_cluster_key:` + `existing_cluster_id:` on same task | Error |

### Cluster / Environment Checks

- `data_security_mode: NONE` when a production target exists → Warning
- `data_security_mode: SINGLE_USER` without `single_user_name` → Warning
- `spark_version` format check (must match `14.3.x` / `14.3.x-scala2.12` pattern)
- `num_workers` must be ≥ 0
- `autotermination_minutes` must be 10–10000
- `max_concurrent_runs` must be 0–1000
- `environments[].spec.client` is required — use `"4"` for current serverless

### Deprecated Fields

| Field | Replacement |
|-------|-------------|
| `photon: true` | `runtime_engine: PHOTON` |
| `jar_uri` in `spark_python_task` | Use `libraries:` with `whl:` or `jar:` |

### File Existence Checks

- `spark_python_task.python_file` — resolved relative to the YAML file's directory
- `notebook_task.notebook_path` — local paths only (not `/Workspace/...`) are checked

## Bundle Target in Connection Wizard

When `databricks.yml` is present, **CatalystOps: Configure Databricks Connection** shows a **Use Bundle Target** option. Select a target (dev / prod / staging) and the wizard pre-fills the workspace host from the YAML — no URL to type manually.

## MCP Tool

The `list_bundle_tasks` MCP tool exposes bundle tasks to Claude, Copilot, and other MCP-compatible clients:

```
You: What tasks are defined in my bundle?
Claude: ↳ calling list_bundle_tasks…
        Found 3 tasks in 2 jobs:
        - daily_etl → extract_data (spark_python_task): src/extract.py
        - daily_etl → transform (spark_python_task): src/transform.py
        - scoring_job → score (notebook_task): src/score.py
```
