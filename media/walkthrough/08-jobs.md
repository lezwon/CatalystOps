# Analyze Historical Job Runs

The **Jobs** sidebar panel lets you inspect past Databricks job runs without re-running anything. CatalystOps reads the Spark event log written by the cluster, extracts physical execution plans, and surfaces issues directly in an interactive DAG view.

---

## The Jobs panel

Open the CatalystOps sidebar and look for the **Jobs** section. It lists your workspace jobs automatically on startup, showing:

- ✅ / ❌ / ⏺  last run status
- How long ago it ran (e.g. `2h ago`)
- How long it took (e.g. `· 14m`)

Click the **↺** refresh button to reload the list.

---

## Analyze a run

Click any job to trigger analysis of its most recent run. CatalystOps will:

1. **Fetch run details** — status, duration, cluster ID
2. **Locate the event log** — reads `SparkListenerSQLExecutionStart` events from DBFS (up to 20 MB)
3. **Extract physical plans** — runs the same plan parser as a dry run, including AQE Initial Plan support
4. **Open the DAG view** — interactive plan tree with issues highlighted per node
5. **Update the Issues panel** — plan-level issues appear in the sidebar for quick navigation

---

## The DAG view

The DAG view shows all SQL queries from the run grouped by their originating notebook command or script action:

- **Tree layout** — each query is rendered as a node tree with `└─` / `├─` connectors showing the operator hierarchy
- **Grouped accordions** — repeated actions with the same description are collapsed into a single group with an execution count badge (e.g. `3 executions`)
- **Issue badges** — nodes with detected issues show a colored severity badge (Critical / Warning / Info)
- **Human-friendly filter conditions** — predicates like `isnotnull(col)` are shown as `col not null`; `&&` becomes `and`
- **📄 View Source** — opens the source notebook or Python script in a side panel (shown when source is available)
- **Raw Plans** — a collapsible section at the bottom shows the full physical plan text for each query group

---

## What issues are detected

The plan parser detects the same issues as a dry run, including:

| Issue | What it means |
|-------|---------------|
| `CrossJoin` / `BroadcastNestedLoopJoin` | Cartesian product — every row paired with every other row |
| `SortMergeJoin` | Expensive shuffle join — consider broadcasting the smaller side |
| `SinglePartitionBottleneck` | `Exchange SinglePartition` — all data collected to one executor (global aggregation or global window) |
| `GlobalWindow` | Window function with no PARTITION BY — eliminates parallelism |
| `SortAggregate` | Slower sort-based aggregation instead of hash-based — caused by complex types or UDAFs |
| `RepeatedFileScan` | Same table scanned multiple times without caching |
| `MissingPartitionFilter` | Partition pruning skipped — full table scan |
| `MissingTableStatistics` | Optimizer lacks row counts — suboptimal join and plan decisions |

> **Note**: Issues already covered by local static analysis (`CrossJoin`, `UnionSchemaMismatch`) are excluded from the DAG view to highlight only plan-level findings.

---

## MCP integration

After a job run analysis the results are available to Claude via the `get_last_job_run_analysis` MCP tool. Claude can read the physical plan and issue list directly without re-fetching from Databricks.

---

## Prerequisites for plan analysis

- The cluster must have **Cluster log delivery** (DBFS destination) configured
- Classic compute only — serverless jobs don't write event logs to DBFS
- The job must have completed at least one run

> **Tip**: If you see "Cluster event logging is not configured", go to your cluster's **Advanced Options > Logging** and set a DBFS destination, then run the job again.

---

## Disabling the panel

Set `catalystops.jobs.enabled` to `false` in settings to hide the Jobs panel entirely.
