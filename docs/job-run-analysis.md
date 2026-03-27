# Job Run Analysis

Analyze any past Databricks job run directly from the **Jobs** sidebar — no re-execution needed.

## How It Works

CatalystOps reads the Spark event log from DBFS, extracts the physical execution plans, runs plan analysis, and opens an interactive DAG view. The entire flow runs in VS Code without triggering another job run.

## Prerequisites

- Databricks connection configured (host + token)
- **Cluster log delivery to DBFS must be enabled** on the cluster the job used

To enable log delivery: open your cluster in Databricks → **Advanced Options** → **Logging** → set Destination to **DBFS** and a log path (e.g. `dbfs:/cluster-logs`). Restart the cluster and re-run the job.

::: warning Serverless Not Supported
Serverless jobs do not write Spark event logs to DBFS. Job run analysis requires a classic interactive or job cluster. Use the [Dry Run](/dry-run) command on the source file for plan analysis of serverless workloads.
:::

## Using the Jobs Panel

1. Open the CatalystOps sidebar — find the **Jobs** panel
2. The panel lists all jobs in your workspace with their last-run status (Success, Failed, Running, etc.)
3. **Double-click** any job to analyze its most recent run
4. A progress notification tracks fetching run details → reading the event log → building the plan view

Click **Refresh Jobs** (or run **CatalystOps: Refresh Jobs List**) to reload the list.

## What You See

After analysis completes:

- **DAG webview** — interactive plan tree for every query in the run, with issue badges and filter conditions in plain English
- **Issues sidebar** — plan issues ranked by severity
- **View Source** button — jumps to the notebook or script that generated the plan (if source path is available in the run metadata)

## Plan Issues Detected

The same plan-level detectors as dry run apply: broadcast hints, shuffle exchanges, single-partition bottlenecks, sort aggregation, global windows, missing partition filters, repeated table scans, and more.

Issues already caught by local static analysis (e.g. `CrossJoin`, `UnionSchemaMismatch`) are excluded from the job run DAG to keep the view focused on findings that require an actual execution plan.

## MCP Access

The most recent job run analysis is exposed via the MCP tool `get_last_job_run_analysis`, so Claude or other AI clients can query it without re-running anything.
