# Changelog

All notable changes to CatalystOps are documented here.

## [Unreleased]

### Added
- Dry-run timeout is now configurable via `catalystops.dryRun.timeoutSeconds` (default: 300s, minimum: 30s). Applies to both cluster and serverless execution modes.

### Fixed
- Safety wrapper no longer corrupts subscript filter expressions containing `==` (e.g. `df[df.eventtype == E1_view].eventtype.count()`). The second `=` of a `==` operator was incorrectly treated as an assignment.

---

## [0.8.0]

### Added
- **Explain Plan view** — new sidebar tree showing the physical query plan after a dry run, with node-level cost scores.
- **DAG visualization** — interactive plan DAG rendered as a webview panel (`CatalystOps: Show Plan DAG`).
- **Context-aware quick fixes** on plan tree nodes: broadcast hint for inefficient joins, repartition for unnecessary exchanges, persist for repeated scans, AQE config for sort-merge joins, and join-condition hint for cartesian products.
- **Plan Tree Builder** — structured representation of Spark physical plans with cost scoring per operation type.
- Analysis cache now tracks the source line for each captured DataFrame, enabling accurate source mapping in the plan view.

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
