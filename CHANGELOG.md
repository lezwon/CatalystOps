# Changelog

All notable changes to CatalystOps are documented here.

## [0.12.0]

### Added
- **Databricks Asset Bundle (DAB) sidebar** — a new **Bundle Tasks** panel lists every `spark_python_task` and `notebook_task` found in `databricks.yml` and all `include:`-referenced resource files. Click any task to open the source file.
- **DAB YAML linting** — 40+ schema-aware validation rules fire inline as you edit `databricks.yml` and resource YAMLs. Catches invalid keys, wrong enum values (`data_security_mode`, `runtime_engine`, `run_if`, `pause_status`, periodic trigger units, health rule metrics), Alert v2 schema mistakes (`condition` → `evaluation`, wrong subscription nesting), permission-level mismatches per resource type, volumes using `permissions` instead of `grants`, missing `spec.client` in job environments, mutually exclusive fields, duplicate `task_key`, missing file references, and more.
- **Bundle target in connection wizard** — "Use Bundle Target" option auto-populates the workspace host from `databricks.yml` targets, letting you pick a dev or prod target without typing a URL.

---

## [0.11.0]

### Added
- **OAuth U2M browser login** — authenticate to any Databricks workspace (AWS, Azure, GCP) by logging in via browser. No tokens to copy/paste. Refresh tokens are stored securely in VS Code's secret storage and auto-refreshed.

---

## [0.10.0]

### Added
- **Azure CLI authentication** — connect to Databricks workspaces using `az login` with no token required. The extension detects available Azure workspaces automatically and resolves the workspace URL.
- **GCP Application Default Credentials** — connect using `gcloud auth application-default login` for GCP-hosted Databricks workspaces.
- **Cost inlay hints** — `@compute` annotations in Python files now show estimated cost inline in the editor, visible without opening the billing panel.
- **MCP server on startup** — the CatalystOps MCP server starts immediately when VS Code opens, with no Python file required. Port is now configurable via `catalystops.mcp.port` (default 49152).

---

## [0.9.2]

### Added
- **Granular SSH telemetry** — tracks auto-start, scope pre-creation, access-mode fix flow, plan-not-supported, and alias-clear events for better usage visibility.

---

## [0.9.1]

### Added
- **One-click SSH connect** — clicking "Connect via SSH" on a stopped cluster now starts it automatically, polls state every 5 s with live progress, and connects once it reaches Running. No manual start required.
- **Auto-fix cluster for SSH** — when `databricks ssh setup` fails due to wrong access mode, the extension offers to set Single User mode and optionally upgrade Spark to 17.3 LTS, then restarts and retries setup automatically.
- **Secret scope pre-creation** — on Standard-tier workspaces that block secret scope creation, the extension pre-creates the scope (`{email}-{clusterId}-ssh-tunnel-keys`) with the correct permissions before connecting, preventing the CLI tunnel from failing.
- **Reset SSH Host** — right-click any cluster → Reset SSH Host to clear the cached alias and force re-setup on next connect.

### Fixed
- Cluster names with special characters (apostrophes, etc.) no longer break `databricks ssh setup`.
- Selecting a different cluster no longer reuses the previous cluster's SSH config — alias lookup now matches by cluster ID in file contents, not by name.
- `remote.SSH.connectTimeout` is automatically raised to 180 s to accommodate Databricks cluster startup time.
- Clearer error messages for unsupported workspace plans and access mode mismatches.
- DAG view now correctly renders plans whose operator tree is entirely under `== Initial Plan ==`.

---

## [0.9.0]

### Added
- **Improved job run DAG view** — the plan tree now renders as an interactive HTML tree with `└─` / `├─` connectors, query groups collapsed into accordions with execution counts, human-friendly filter conditions (`col not null`, `a and b`), a **View Source** button to open the originating notebook, and a collapsible Raw Plans section for debugging.
- **3 new plan-level issue detectors:**
  - `SinglePartitionBottleneck` — flags `Exchange SinglePartition`, which collects all data to a single executor (caused by global aggregation or global window).
  - `SortAggregate` — flags sort-based aggregation, which is slower than hash-based and prone to spilling on large datasets.
  - `GlobalWindow` via `RunningWindowFunction` — extends the existing global-window check to cover Databricks Photon's `RunningWindowFunction` operator.
- **Plan parser: AQE Initial Plan analysis** — plans whose operator tree sits entirely under `== Initial Plan ==` (AQE has not yet resolved a final plan) are now analysed instead of being silently skipped.
- **MCP: `get_last_job_run_analysis` tool** — exposes the most recent job run's plan issues and physical plan text to Claude without re-fetching from Databricks.

---

## [0.8.3]

### Added
- **Jobs sidebar** — new Jobs tree view lists all Databricks jobs with their last-run status. Click any job to trigger historical run analysis without re-executing it.
- **Historical job run analysis** — reads Spark event logs from DBFS to extract physical plans and surface plan issues and code diagnostics from a past run. Opens a markdown report in a new editor tab (`CatalystOps: Analyze Job Run`).
- **SSH tunnel execution mode** — run dry-run analysis directly on a Databricks cluster driver over SSH. Enable via `catalystops.connection.sshTunnel.enabled` + `catalystops.connection.sshTunnel.connectionName`. Requires Databricks CLI ≥ 0.269 and DBR 17+.
- **Marketplace rating prompt** — shown after 5 sessions or 2 billing data fetches (max 2 times, permanently dismissible).
- **4 new static analysis rules:**
  - `CODE_ITER_COLLECT_001` (Critical) — detects `for row in df.collect()` patterns that pull the full dataset to the driver and iterate row-by-row.
  - `CODE_REPARTITION_WRITE_001` (Warning) — detects `.repartition(N)` immediately before a write, where `.coalesce()` avoids the full shuffle.
  - `CODE_UDF_FILTER_001` (Warning) — detects Python UDFs inside `.filter()` that block predicate pushdown on partitioned/Delta tables.
  - `CODE_REPEATED_ACTIONS_001` (Warning) — detects multiple Spark actions (`.count()`, `.show()`, etc.) on the same DataFrame within 50 lines without an intervening `.cache()`.
- **Plan parser: missing partition filter detection** — flags `PartitionFilters: []` on qualified table scans, indicating every partition will be read with no pruning.
- **Plan parser: additional scan pattern** — `Scan parquet/delta ...` node format (in addition to `FileScan`/`PhotonScan`) now correctly extracts table names for downstream detectors.
- **Telemetry: error classification** — dry run errors are now categorised (import error, syntax error, Spark analysis error, auth, timeout, OOM, network) before sending, so no raw code or stack traces are transmitted.
- **Telemetry: execution mode tracking** — `analyze_cost_mode` event records which execution mode (cluster / serverless / ssh) was used per dry run.
- **Telemetry: failure duration** — `analysis/failed` event now includes `durationMs` for latency tracking.

### Changed
- **License** — switched from MIT to [Elastic License 2.0 (ELv2)](https://www.elastic.co/licensing/elastic-license). Source remains publicly available; hosting or redistributing the extension as a competing product or managed service is not permitted.
- **Feedback toast** — now triggers after 100 successful local analyses (previously after a 5-second timer on first file open), preventing premature prompts for new users.
- **Feedback toast placement** — moved to fire after `runLocalAnalysis` completes rather than on editor switch, so it only appears after a real analysis result.

### Fixed
- **Quick-fix commands** — broadcast hint, repartition, persist, and add-join-condition quick fixes now guard against out-of-bounds source line numbers before attempting editor edits.
- **Persist quick fix** — `insertLine` is now clamped to `document.lineCount` to avoid inserting past the end of the file.
- **Diagnostics range** — `setCodeIssueDiagnostics` now clamps all range coordinates to `≥ 0`, preventing VS Code from throwing on negative line/column values.
- **Result mapper** — `resolveLocation` now clamps parsed line numbers to `≥ 0` via `Math.max(0, ...)`.

---

## [0.8.1]

### Added
- **Hover explanations** — all local analysis rules now show a detail explanation and quick-fix code snippet when hovering over a highlighted issue. Covers all Spark, streaming, Delta, and DLT rules including the rules added in 0.6.0.

### Fixed
- **`CODE_DLT_PARTITION_001`** now detects the Python DLT API (`partition_cols=["col"]`) and SQL `PARTITIONED BY` in addition to the bare `PARTITION BY` keyword.
- **`CODE_AUTOLOADER_RATE_001`** now triggers on `.format("cloudFiles")` (the standard Auto Loader declaration), not just on the explicit `.option("cloudFiles.format", ...)` option.
- **`CODE_MERGE_DV_001` / `CODE_MERGE_RLC_001`** now detect the PySpark DeltaTable `.alias(...).merge(...)` API in addition to SQL `MERGE INTO`.
- **`CODE_ANALYZE_001`** now triggers on `.mode("overwrite").save(...)` in addition to `.saveAsTable()` and `.insertInto()`.
- Hover popup no longer shows the `CatalystOps(CODE_...)` rule-ID suffix below the message.

### Changed
- Extension package trimmed: `icon.svg`, `catalystops.css`, and `.gitignore` are no longer included in the `.vsix`. `CHANGELOG.md` is now correctly included for marketplace display.

---

## [0.8.0]

### Added
- **Explain Plan view** — new sidebar tree showing the physical query plan after a dry run, with node-level cost scores.
- **DAG visualization** — interactive plan DAG rendered as a webview panel (`CatalystOps: Show Plan DAG`).
- **Context-aware quick fixes** on plan tree nodes: broadcast hint for inefficient joins, repartition for unnecessary exchanges, persist for repeated scans, AQE config for sort-merge joins, and join-condition hint for cartesian products.
- **Plan Tree Builder** — structured representation of Spark physical plans with cost scoring per operation type.
- Analysis cache now tracks the source line for each captured DataFrame, enabling accurate source mapping in the plan view.
- Dry-run timeout is now configurable via `catalystops.dryRun.timeoutSeconds` (default: 300s, minimum: 30s). Applies to both cluster and serverless execution modes.


---

## [0.7.0]

### Added
- **MCP server** — CatalystOps exposes a Streamable HTTP MCP server (auto-discovered in VS Code 1.99+) with tools (`analyze_pyspark`, `get_active_file_issues`, `get_billing_summary`, `refresh_billing`, `get_plan_analysis`, `run_dry_run`), resources, and prompts for integration with Claude and other MCP clients.
- In-memory MCP state snapshot is updated after every local analysis.

---

## [0.6.0]

### Added
- **Billing dashboard** — dedicated sidebar view showing DBU and dollar spend per period, fetched from `system.billing.usage` with a 1-hour cache.
- User confirmation prompt before fetching billing data to avoid unexpected SQL warehouse charges.
- New DLT analysis rules: detect DLT pipeline anti-patterns alongside existing Spark checks.
- Additional static analysis checks including `CODE_REPRO_001` (repeated source without cache).

---

## [0.5.0]

### Added
- **Repeated source scan detection** — warns when a source DataFrame (`spark.read.*`, `spark.table`, `spark.sql`) is reused multiple times without `.cache()` or `.persist()`, tracing aliases and derived DataFrames transitively. Configurable via `catalystops.analysis.enableRepeatedScanDetection`.
- **Schema extraction and validation** — tracks inferred schemas across `spark.read`, `spark.createDataFrame`, and UDFs; validates join column existence and type compatibility; detects schema mismatches on write operations.
- **Static cost estimation from annotations** — cost estimates shown inline in the Issues tree view without requiring a dry run.
- **Dry-run nudge** — after several local scans without a dry run, users are prompted to enable Databricks-backed analysis.

---

## [0.4.0]

### Added
- **Actual billing query after serverless runs** — optionally submits a background job querying `system.billing.usage` to surface real DBU consumption after each dry run (`catalystops.cost.queryBillingUsage`).
- **Cross-DataFrame scan detection** — detects when the same underlying table is scanned by multiple DataFrames in the same file.
- Serverless job run page URL captured and shown in the progress UI for easy navigation to the Databricks run.
- Auto-analysis for tables with missing or partial statistics during cluster execution.
- Plan parsing improved for Photon-enabled clusters.
- `# noqa: catalystops` comment support to suppress individual diagnostics.

### Fixed
- Output retrieval for serverless job runs correctly handles both notebook-task and spark-task result formats.
- Serverless dry run now works on Databricks Free Edition workspaces.

---

## [0.3.4]

### Added
- Billing query integration for serverless runs (initial implementation).
- Improved serverless run page URL handling.

---

## [0.3.3]

### Added
- Telemetry: feedback toast after first successful dry run.
- Publishing scripts for VSCE and OVSX marketplaces.

### Fixed
- Streaming deduplication detection description updated.

---

## [0.3.2 – 0.3.1]

### Fixed
- Output file path for esbuild corrected to include `vscode/` prefix.
- Demo image path in README.
- `.vscodeignore` updated to include demo assets.

---

## [0.2.0]

### Added
- **Serverless execution mode** — run dry-run analysis on Databricks Serverless Compute without a cluster ID (`catalystops.databricks.executionMode: serverless`).
- **Serverless cost estimation** — data-volume-based dollar estimate using configurable `catalystops.cost.serverlessRatePerHour`.
- Table statistics extraction for more accurate cost estimates.
- Streaming deduplication detection.
- `display(df)` calls replaced by `_catalystops_capture(df)` in the safety wrapper for correct plan capture.
- Preview dry-run script command to inspect the neutralized code before submitting.
- Telemetry for extension activation and analysis events.

---

## [0.1.0] — Initial release

### Added
- Local static analysis with 30+ PySpark anti-pattern detectors (no cluster required).
- Cluster-based dry-run analysis via Databricks Command Execution API 1.2.
- Safety wrapper (`neutralizeCode`) replacing dangerous actions (`.collect()`, `.write`, `.show()`, etc.) with `explain("formatted")` calls.
- Logical and physical plan parsing with hover information and diagnostics.
- Cache spill detection, partitioning recommendations, checkpoint usage warnings.
- Cost estimation from cluster execution duration.
- Diagnostics panel integration with quick-fix suggestions.
- Import bundling for local modules referenced in the analyzed script.
- `catalystops.databricks.host`, `catalystops.databricks.token`, `catalystops.databricks.clusterId` configuration.
