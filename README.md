<div align="center">
  <img src="https://raw.githubusercontent.com/lezwon/CatalystOps/refs/heads/main/media/icon.png" alt="CatalystOps Logo"/>
</div>

<h1 align="center">CatalystOps — PySpark Optimizer</h1>

**CatalystOps** catches PySpark performance issues before they hit production. It detects **35+ anti-patterns** locally in real time, validates **column names, types, and schema alignment** at edit time, estimates **notebook compute costs** from source annotations, runs **safe dry-run analysis** on a Databricks cluster or serverless compute to inspect Catalyst execution plans, and tracks **actual Databricks spending** in a built-in billing dashboard — all without executing Spark jobs or touching your data. Plan parsing is fully **Photon-aware** and detects cross-DataFrame repeated scans across your entire script.

> **Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CatalystOps.catalystops)**

---

![CatalystOps Demo](https://iili.io/qFE28FV.gif)

## Why CatalystOps?

PySpark makes it easy to write code that *works* but runs slowly or expensively at scale. Common pitfalls — `collect()` on large DataFrames, cartesian joins, missing broadcast hints, repeated table scans, union schema mismatches, and cache misconfigurations — often slip past code review and only surface as runaway cluster bills.

CatalystOps gives you **three layers of analysis**:

- **Instant local checks** as you type — no cluster required
- **Schema-aware checks** — column names, types, and set-operation alignment validated against schemas defined in the same file
- **Deep plan analysis** on your actual Databricks cluster or serverless compute, parsing Catalyst physical and logical plans to catch issues that only appear at runtime

---

## Features

### Local Analysis (No Cluster Required)

Detects anti-patterns instantly via regex-based pattern matching with full comment-awareness:

| Severity | Checks |
|----------|--------|
| **Critical** | `collect()`, `crossJoin()`, SQL injection via f-strings in `spark.sql()`, `kafka.enable.auto.commit = true`, `APPLY AS DELETE WHEN` after `SEQUENCE BY` in DLT AUTO CDC |
| **Warning** | `collect()` on streaming (cross-batch stateful dedup), `toPandas()`, `coalesce(1)`, `repartition(1)`, `dropDuplicates()` without subset, `withColumn` in loops, `.rdd` conversion, `checkpoint()`, `Window.orderBy()` without `partitionBy` (global window), AQE disabled via `spark.conf.set`, deprecated pandas `.append()`, non-deterministic UDFs, **unknown column names**, **type mismatches** (numeric / string / date / array functions on wrong column type), streaming checkpoint on DBFS (`/dbfs/` or `dbfs:/`), `.writeStream.start()` without `.trigger()`, `.groupBy()` on streaming DataFrame without `.withWatermark()`, `DROP TABLE` + `CREATE TABLE` (use `CREATE OR REPLACE TABLE`), `dynamicAllocation.enabled = true` on streaming cluster, `FloatType`/`DoubleType` for financial columns (use `DecimalType`), `OPTIMIZE` after every `MERGE` in `foreachBatch`, inner join in streaming file (silently drops unmatched events), `read_files()` without `schemaHints` in DLT pipeline, `PARTITION BY` instead of `CLUSTER BY` in DLT table |
| **Warning** _(opt-in)_ | Source DataFrame used 2+ times without `.cache()` / `.persist()` — tracks aliases and derived DataFrames transitively. Enable via `catalystops.analysis.enableRepeatedScanDetection`. |
| **Info** | UDF usage, schema inference, chained `.filter()`, `show()` / `display()` in production, `cache()` without `unpersist()`, `select("*")`, global `orderBy`, missing write mode, `pandas_udf`, `to_pandas_on_spark()`, static partition overwrite without dynamic config, `Table May Lack Statistics`, `ZORDER BY` (use Liquid Clustering), missing `.option("queryName", ...)` on streaming query, no `ANALYZE TABLE` after overwrite, `MERGE` without Deletion Vectors (`delta.enableDeletionVectors`), `MERGE` without Row-Level Concurrency (`delta.enableRowLevelConcurrency`), Auto Loader without `maxBytesPerTrigger`, stateful streaming without RocksDB state store, `SELECT *` in DLT pipeline, `CLUSTER BY AUTO` in production DLT table |

Each issue shows a **one-line explanation** and a **quick fix code block** on hover.

#### Streaming & Delta Checks

| Issue ID | Severity | What it detects |
|----------|----------|-----------------|
| `CODE_KAFKA_001` | **Critical** | `kafka.enable.auto.commit = true` — Kafka manages offsets independently of Spark's checkpoint, causing data loss or duplication |
| `CODE_STREAM_TRIGGER_001` | **Warning** | `.writeStream.start()` without `.trigger()` — continuous micro-batches cause excessive cloud storage listing and unpredictable compute costs |
| `CODE_DBFS_CHECKPOINT_001` | **Warning** | Streaming checkpoint stored on DBFS (`/dbfs/` or `dbfs:/`) — DBFS is unreliable for checkpoint storage; use Unity Catalog Volumes or S3/ADLS |
| `CODE_STREAM_WATERMARK_001` | **Warning** | `.groupBy()` on a streaming DataFrame without a preceding `.withWatermark()` — state grows unbounded, causing OOM failures |
| `CODE_STREAM_JOIN_001` | **Warning** | Default inner join in a streaming file — silently drops events with no matching dimension record; use `how="left"` to preserve all events |
| `CODE_DROP_CREATE_001` | **Warning** | `DROP TABLE` followed by `CREATE TABLE` within 5 lines — non-atomic, breaks concurrent readers and deletes time-travel history; use `CREATE OR REPLACE TABLE` |
| `CODE_DYN_ALLOC_STREAM_001` | **Warning** | `spark.dynamicAllocation.enabled = true` in a streaming script — causes latency spikes and executor churn; use a fixed-size cluster for streaming |
| `CODE_FLOAT_FINANCIAL_001` | **Warning** | `FloatType` or `DoubleType` for columns named `price`, `amount`, `revenue`, `cost`, etc. — binary floating-point causes silent rounding errors; use `DecimalType(18, 2)` |
| `CODE_MERGE_OPTIMIZE_001` | **Warning** | `OPTIMIZE` immediately after `MERGE INTO` — runs full compaction on every batch; enable Liquid Clustering (`CLUSTER BY`) to compact incrementally instead |
| `CODE_ZORDER_001` | **Info** | `ZORDER BY` / `Z-ORDER BY` — legacy optimization that rewrites the full table on each OPTIMIZE run; replace with `CLUSTER BY` (Liquid Clustering) |
| `CODE_STREAM_QUERYNAME_001` | **Info** | `.writeStream.start()` without `.option("queryName", ...)` — unnamed queries appear as random UUIDs in the Spark UI and structured streaming metrics |
| `CODE_ANALYZE_001` | **Info** | `mode("overwrite").saveAsTable(...)` or `INSERT OVERWRITE` without `ANALYZE TABLE` — stale statistics cause suboptimal join and partition decisions |
| `CODE_MERGE_DV_001` | **Info** | `MERGE INTO` without `delta.enableDeletionVectors = true` — every update/delete physically rewrites files; Deletion Vectors convert these to cheap soft-deletes |
| `CODE_MERGE_RLC_001` | **Info** | `MERGE INTO` without `delta.enableRowLevelConcurrency = true` — concurrent MERGEs conflict at the file level; Row-Level Concurrency eliminates unnecessary conflicts |
| `CODE_AUTOLOADER_RATE_001` | **Info** | Auto Loader stream (`cloudFiles.format`) without `maxBytesPerTrigger` — no backlog protection; a large backlog is processed in a single OOM-prone batch |
| `CODE_ROCKSDB_001` | **Info** | Stateful streaming operation (`.groupBy()`, `flatMapGroupsWithState`) without RocksDB state store configured — the default in-memory store will OOM for large state; enable `RocksDBStateProvider` |

#### DLT / Spark Declarative Pipeline Checks

These checks only fire in files that contain DLT syntax (`@dlt.table`, `@dp.table`, `APPLY CHANGES INTO`, `CREATE STREAMING LIVE TABLE`, etc.).

| Issue ID | Severity | What it detects |
|----------|----------|-----------------|
| `CODE_DLT_PARTITION_001` | **Warning** | `PARTITION BY` on a DLT table — creates fixed-layout partitions requiring manual OPTIMIZE; use `CLUSTER BY` (Liquid Clustering) instead |
| `CODE_DLT_SCHEMA_HINTS_001` | **Warning** | `read_files()` without `schemaHints` — full schema inference is slow on startup and breaks on type changes; pin critical column types with `schemaHints` |
| `CODE_DLT_CDC_ORDER_001` | **Critical** | `APPLY AS DELETE WHEN` placed after `SEQUENCE BY` in an `APPLY CHANGES INTO` block — the correct order is `APPLY AS DELETE WHEN` first, then `SEQUENCE BY` |
| `CODE_DLT_SELECT_STAR_001` | **Info** | `SELECT *` in a DLT pipeline — reads all columns unnecessarily; select only the columns downstream consumers need |
| `CODE_DLT_CLUSTER_AUTO_001` | **Info** | `CLUSTER BY AUTO` in a production DLT table — useful for prototyping; for production tables under 10 TB, explicit keys chosen to match query patterns will outperform AUTO |

---

### Schema Validation (No Cluster Required)

When a `StructType` or DDL schema is defined in the same file, CatalystOps validates column references, function types, and set-operation alignment at edit time — before code ever runs on a cluster.

**Supported schema definition styles:**

```python
# StructType
schema = StructType([
    StructField("user_id", IntegerType()),
    StructField("name", StringType()),
])

# DDL string
schema = "user_id INT, name STRING, ts TIMESTAMP"
```

**Supported DataFrame creation patterns:**

```python
df = spark.createDataFrame(data, schema)
df = spark.createDataFrame(data, schema=schema)
df = spark.createDataFrame(data, "user_id INT, name STRING")
df = spark.read.schema(schema).parquet(path)
df = spark.readStream.schema(schema).json(path)
```

**Column and type checks:**

| Check | Issue ID | Example |
|-------|----------|---------|
| Unknown column name | `SCHEMA_COL_001` | `df.select("usr_id")` when schema has `"user_id"` |
| Type mismatch — numeric function on non-numeric column | `SCHEMA_TYPE_001` | `F.sum("name")` where `name` is `StringType` |
| Type mismatch — string function on non-string column | `SCHEMA_TYPE_001` | `F.upper("created_at")` where `created_at` is `TimestampType` |
| Type mismatch — date function on non-date column | `SCHEMA_TYPE_001` | `F.year("name")` where `name` is `StringType` |
| Type mismatch — array function on non-array column | `SCHEMA_TYPE_001` | `F.explode("name")` where `name` is `StringType` |

Column references are checked in `.select()`, `.drop()`, `.groupBy()`, `.orderBy()`, `.sort()`, `.partitionBy()`, `.withColumnRenamed()`, `col("name")`, and `df["name"]` expressions.

**Set-operation schema checks:**

| Check | Issue ID | Severity | Description |
|-------|----------|----------|-------------|
| `union()` — different column sets | `CODE_UNION_002` | Critical | Schemas don't match; suggests `unionByName(allowMissingColumns=True)` |
| `union()` — same columns, different order | `CODE_UNION_002` | Critical | Rows silently matched by wrong position |
| `union()` — schemas fully compatible | `CODE_UNION_002_MATCH` | Suggestion | Safe, but `unionByName()` is more robust |
| `intersect()` / `intersectAll()` — same columns, different order | `CODE_INTERSECT_002` | Critical | Rows compared by wrong column position |
| `except()` / `exceptAll()` / `subtract()` — same columns, different order | `CODE_EXCEPT_002` | Critical | Rows compared by wrong column position |
| Two DataFrames with same column names but different order | `SCHEMA_ALIGN_001` | Warning | Proactive alert at definition time — before any set-op is written |
| Join condition type mismatch | `SCHEMA_JOIN_001` | Warning | e.g. joining `INT` vs `STRING` on the same key |

> `intersect()`, `except()`, and `subtract()` only flag **order mismatches** (same column set, different order) — the silent wrong-result bug. Completely different column sets are not flagged since that produces an obvious runtime error.

**Schema propagation** — schemas flow through transformations:

```python
df2 = df.filter("active = true")         # same schema as df
df3 = df.select("user_id", "name")       # subset: only user_id, name
df4 = df.drop("name")                    # name removed
df5 = df.withColumn("score", ...)        # score added (type = unknown)
df6 = df.withColumnRenamed("name", "full_name")  # renamed
df7 = df.join(other, "id")              # schema unknown — no false positives
```

**"Did you mean?" suggestions** — when a column name is wrong, CatalystOps suggests the closest match:

```
Column "usr_id" not found in schema of "df". Did you mean: "user_id"?
```

**Suppression** — add `# noqa: catalystops` to skip a line:

```python
df.select("legacy_col")  # noqa: catalystops
```

> Schema validation only fires when a schema is defined in the **same file**. DataFrames loaded from external sources (`spark.table()`, `spark.sql()`, `spark.read` without `.schema()`) are silently skipped — no false positives.

---

### Static Cost Estimation (No Cluster Required)

Annotate your Python file with `# @compute:` and `# @size:` to get an instant dollar estimate directly in the editor — no cluster connection needed.

**Annotation format:**

```python
# @compute: nodes=4, cores=2, memory=16GB, rate=0.25

big_df = spark.read.parquet("s3://bucket/events")  # @size: 50GB
lookup = spark.read.csv("s3://bucket/lookup")       # @size: 200MB
```

| Key | Required | Description |
|-----|----------|-------------|
| `nodes` | Yes | Number of worker nodes |
| `cores` | Yes | Cores per node |
| `memory` | Yes | Memory per node (`GB`, `MB`, `KB`, `TB`) |
| `rate` | Yes | Total cluster cost in $/hr |
| `overhead` | No | Multiplier for full-notebook cost beyond scans (default `2.0`) |

**How the estimate is calculated:**

```
scan_hours = total_bytes / 500 MB/s / 3600
scan_cost  = scan_hours × rate
total_cost = scan_cost × overhead_factor
```

The 500 MB/s throughput is a conservative Delta/Parquet scan assumption. The `overhead` multiplier (default `2.0`) accounts for transforms, shuffles, and writes on top of the raw scan cost.

**What you see:**

- **CodeLens** — appears above the `# @compute:` line:
  ```
  $(circuit-board) Estimated cost: ~$0.0018  (50.2 GB @ $0.25/hr)
  ```
- **Sidebar panel** — a collapsible "Estimated cost" group in the Issues tree showing total data, cluster spec, and rate

---

### Billing Dashboard (Requires Databricks Unity Catalog System Tables)

Track actual Databricks spending without leaving VS Code. The billing dashboard queries `system.billing.usage` via the Databricks SQL Statement Execution API and visualises cost broken down by user, job, and workload type.

**Sidebar tree view** — always visible in the CatalystOps panel:

```
$(graph) Last 7 days: $84.20  (312.5 DBUs)
├── By User
│   ├── alice@company.com          $52.10
│   └── bob@company.com            $32.10
├── By Job
│   ├── pipeline_etl (123)         $41.00
│   └── daily_agg (456)            $43.20
└── By Workload
    ├── JOBS                        $71.50
    └── SQL                         $12.70
```

**Webview dashboard** — opens beside your editor with:

- **Period tabs**: Day (last 24 hrs) · Week (last 7 days) · Month (last 30 days) · Custom date range
- **Metric cards**: Total cost · DBUs · unique users · unique jobs
- **CSS bar charts**: Top 10 users, top 10 jobs, workload breakdown
- **Daily trend chart**: Bar chart of per-day spend over the selected window
- **↻ Refresh** button to force a live re-query; tab switches use the 1-hour cache

**How it works:**

1. Auto-discovers a SQL warehouse (prefers running serverless; override via `catalystops.billing.warehouseId`)
2. Submits a SQL query to `system.billing.usage` joined with `system.billing.list_prices` for list-price dollars
3. Results are cached locally for 1 hour; Refresh bypasses the cache
4. If a fetch fails, the dashboard restores the last successful result

> **Requirement**: Unity Catalog System Tables must be enabled on your workspace (`system.billing.usage`).

---

### Cluster Analysis — Catalyst Plan Inspection (Databricks Dry Run)

When a Databricks connection is configured, CatalystOps submits a neutralized version of your script to the cluster or serverless compute and parses both the **physical** and **analyzed logical** execution plans.

#### How it works — safely

1. **Safety wrapping** — writes, collects, streaming actions, and all action calls are neutralized so no data is modified or moved
2. **Plan capture** — a `_catalystops_capture(df)` call is injected in place of each action. This function captures the DataFrame's `explain("formatted")` output using stdout redirection, and works with streaming DataFrames and DataFrames defined inside functions
3. **Local file bundling** — imported local `.py` files are detected and inlined automatically
4. **Plan parsing** — physical and logical plans are analyzed for expensive patterns

#### Neutralized actions

| Original | Replacement |
|----------|-------------|
| `df.collect()` | `_catalystops_capture(df)` |
| `df.count()` | `_catalystops_capture(df)` |
| `df.show()` | `_catalystops_capture(df)` |
| `df.toPandas()` | `_catalystops_capture(df)` |
| `df.write.mode(...).save(...)` | `_catalystops_capture(df)` |
| `df.writeStream....start()` | `_catalystops_capture(df)` (full chain dropped) |
| `display(df)` | `_catalystops_capture(df)` |
| `query.awaitTermination()` | `# [CatalystOps: neutralized]` |

#### Join Detection

| Issue | What it means |
|-------|---------------|
| **Broadcast Hash Join** | Small table broadcast — efficient, no action needed |
| **Sort-Merge Join** | Both sides shuffled — consider broadcasting the smaller side |
| **Small Side Not Broadcast** | One side is small enough to broadcast but Spark chose sort-merge |
| **Shuffled Hash Join** | Consider broadcasting if the smaller side fits in executor memory |
| **Cartesian Product** | O(n×m) rows — catastrophically expensive, add a join condition |
| **Broadcast Nested Loop Join** | No join keys — iterating every row combination |
| **Broadcast Join → Single Partition Bottleneck** | Broadcast join immediately followed by a global aggregation |

#### Shuffle & Partition Detection

| Issue | What it means |
|-------|---------------|
| **Shuffle Exchange** | Data redistributed across partitions — minimize with caching or partition reuse |
| **Too Few Shuffle Partitions** | Very few output partitions → OOM risk and slow processing |
| **Default 200 Shuffle Partitions on Large Data** | `Exchange hashpartitioning(..., 200)` on a large dataset — suggests tuning `spark.sql.shuffle.partitions` or enabling AQE |

#### Cache & Persistence Detection

| Issue | What it means |
|-------|---------------|
| **Large DataFrame Cached** | A large DataFrame is being cached — suggests selecting only needed columns |
| **Cache Spilling to Disk** | Cached data has exceeded executor memory and is spilling — offers three remediation options |
| **Cache Using Deserialized Java Objects** | `MEMORY_ONLY` storage uses 3–5× more heap than Kryo-serialized storage |
| **Cached Relation Re-Scanned** | Same cached DataFrame read multiple times — restructure to reference once |
| **Cache Will Spill to Disk** | Cache size exceeds cluster memory estimate |

#### Read Efficiency Detection

| Issue | What it means |
|-------|---------------|
| **Same Source Scanned Multiple Times** | Physical or logical plan shows the same table/file scanned more than once — suggests caching after first read |
| **Same Table Scanned Across DataFrames** | The same source table appears in the physical plans of multiple DataFrames — read once and cache before reuse |
| **CSV Format — Use Parquet/Delta** | CSV disables columnar reads, predicate pushdown, and vectorised execution |
| **Missing Table Statistics** | Optimizer lacks statistics for join and partition decisions |
| **first() Without Ordering Guarantee** | Non-deterministic result in distributed execution |

> **AQE-aware**: CatalystOps correctly ignores the `== Initial Plan ==` section in Adaptive Query Execution plans to prevent false positives.

> **Photon-aware**: Join, shuffle, and scan detections cover Photon-native node types (`PhotonBroadcastHashJoin`, `PhotonSortMergeJoin`, `PhotonShuffledHashJoin`, `PhotonShuffleExchangeSink`, `PhotonShuffleExchangeSource`, `PhotonScan`) — ensuring accurate issue counts on Photon-accelerated clusters and serverless compute.

---

### MCP Server — AI Assistant Integration

CatalystOps exposes its analysis data as an **MCP (Model Context Protocol) server** so that AI assistants — Claude, GitHub Copilot (VS Code 1.99+), Cursor, and any other MCP-compatible client — can read live analysis results without any copy/paste.

The server starts automatically when the extension activates and runs **in-process** on a dynamic port. The port is printed to the CatalystOps Output panel on startup:

```
CatalystOps: MCP server listening on http://127.0.0.1:49312/mcp
```

#### Tools (AI can call)

| Tool | Input | What it returns |
|------|-------|-----------------|
| `analyze_pyspark` | `{ code: string }` | Static issues (id, severity, line, title, description, fix) for any code snippet — no cluster required |
| `get_active_file_issues` | _(none)_ | Issues + file path for the currently open VS Code editor |
| `get_billing_summary` | `{ period?: "day"\|"week"\|"month" }` | totalDollars, DBUs, byUser, byJob, byWorkload — reads the local 1-hour cache |
| `refresh_billing` | `{ period?: "day"\|"week"\|"month" }` | Forces a live Databricks SQL query and returns updated billing data |
| `get_plan_analysis` | _(none)_ | Parsed plan issues from the last dry run: join types, shuffle count, repeated scans, cache spills |
| `run_dry_run` | _(none)_ | Triggers a Databricks dry run on the active file and returns physical/logical plan text + parsed issues |

#### Resources (AI can read as context)

| URI | Content |
|-----|---------|
| `catalystops://issues/current` | Markdown table of local analysis issues for the active file |
| `catalystops://plans/last` | Raw Catalyst physical + analyzed logical plan text from the last dry run |
| `catalystops://billing/summary` | Markdown billing snapshot (last cached period) |

#### Prompts

| Name | Description |
|------|-------------|
| `pyspark_code_review` | Injects local findings + plan issues as context for a code review prompt |
| `optimize_spark_plan` | Injects raw Catalyst plan text and asks the model for optimization recommendations |

#### Connecting AI clients

**VS Code Copilot (v1.99+)** — auto-discovered automatically. CatalystOps tools appear in Copilot Chat under `@`.

**Claude Desktop / Cursor / other MCP clients** — add the server manually using the port shown in the Output panel:

```json
{
  "servers": {
    "catalystops": {
      "url": "http://127.0.0.1:<port>/mcp"
    }
  }
}
```

For Claude Desktop, add this to `claude_desktop_config.json`. For Cursor, add it to MCP settings.

> The port changes on each VS Code restart. For a stable port, connect after reading it from the Output panel. MCP clients that support dynamic discovery via VS Code will handle this automatically.

---

### Editor Integration

- **Inline diagnostics** — squiggly underlines with exact line/column positions, visible in the Problems panel
- **Hover tooltips** — clean markdown cards with a one-sentence explanation and a `Quick fix:` code block for every detected issue
- **CodeLens** — inline warnings above high-risk operations (`collect()`, `repartition(1)`, `coalesce(1)`, `checkpoint()`) and estimated cost above `# @compute:` annotations
- **Quick Fix** actions (`⌘.` / `Ctrl+.`) — context-aware code suggestions
- **Issues tree view** — sidebar panel listing all local and dry-run issues by severity with line numbers, plus estimated cost and write operation summaries
- **Progress steps** — live sidebar progress showing each analysis stage (local analysis → cluster check → script generation → cluster run → parsing)
- **Status bar** — real-time issue counts (critical / warning / info)
- **HTML reports** — shareable full analysis breakdown
- **Open in Databricks** — clickable button on analysis toast notifications linking directly to the Databricks run UI (shown when the run starts and again on completion)

---

## Getting Started

### Install from the VS Code Marketplace

Search for **CatalystOps** in the Extensions panel, or install directly:

```
ext install CatalystOps.catalystops
```

Local analysis works immediately after install — no configuration needed.

---

### Configure Databricks Connection (for dry-run plan analysis)

Run **CatalystOps: Configure Databricks Connection** from the Command Palette (`⌘⇧P`).

#### Option A — Interactive cluster

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi...",
  "catalystops.databricks.clusterId": "0123-456789-abcdef"
}
```

#### Option B — Serverless compute (no cluster needed)

Leave **Cluster ID blank** in the configuration wizard — CatalystOps automatically switches to serverless mode. Requires a Databricks Premium workspace.

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.executionMode": "serverless"
}
```

#### Option C — Databricks CLI config file

```jsonc
{
  "catalystops.databricks.configPath": "~/.databrickscfg",
  "catalystops.databricks.profile": "DEFAULT"
}
```

---

## Usage

| Command | Shortcut | Description |
|---------|----------|-------------|
| **CatalystOps: Analyze Cost (Dry Run)** | `⌘⇧K` / `Ctrl+Shift+K` | Run local + cluster analysis on the active file |
| **CatalystOps: Analyze Selected Code** | — | Analyze only the highlighted selection |
| **CatalystOps: Show Report** | — | Open a shareable HTML report of the last analysis |
| **CatalystOps: Configure Databricks Connection** | — | Interactive connection setup wizard |
| **CatalystOps: Show Generated Script** | — | View the full neutralized script sent to the cluster |
| **CatalystOps: Preview Dry-Run Script** | — | Preview only the neutralized user code (before submission) |
| **CatalystOps: Show Billing Dashboard** | — | Open the billing dashboard (defaults to last 7 days) |
| **CatalystOps: Refresh Billing Data** | — | Force a fresh billing query, bypassing the cache |

### Typical Workflow

1. Open a `.py` file — local analysis runs instantly
2. Review inline diagnostics and the Issues tree view in the sidebar
3. Hover over any underlined code for a detailed explanation and quick fix
4. Press `⌘⇧K` to run a deeper cluster-backed plan analysis
5. Apply fixes via Quick Fix (`⌘.`) or the hover card suggestions
6. Generate a shareable report with **Show Report**

---

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `catalystops.databricks.host` | `""` | Databricks workspace URL |
| `catalystops.databricks.token` | `""` | Personal access token (leave blank to use `.databrickscfg`) |
| `catalystops.databricks.clusterId` | `""` | Interactive cluster ID (leave blank to use serverless) |
| `catalystops.databricks.configPath` | `~/.databrickscfg` | Path to Databricks CLI config file |
| `catalystops.databricks.profile` | `DEFAULT` | Config profile name |
| `catalystops.databricks.executionMode` | `cluster` | `cluster` or `serverless` — auto-set to `serverless` when cluster ID is blank |
| `catalystops.analysis.autoAnalyzeOnSave` | `false` | Auto-analyze on save |
| `catalystops.analysis.enableLocalCodeAnalysis` | `true` | Enable local anti-pattern detection |
| `catalystops.analysis.enableRepeatedScanDetection` | `false` | Warn when a source DataFrame (`spark.read.*`, `spark.table`, `spark.sql`) is used 2+ times without `.cache()` or `.persist()`. Tracks aliases and derived DataFrames transitively. Disabled by default — enable if you want to audit scan reuse in complex pipelines. |
| `catalystops.cost.dbuRatePerHour` | `0.4` | DBU rate ($/hr) for interactive cluster cost estimation |
| `catalystops.cost.serverlessRatePerHour` | `0.7` | Effective hourly cost ($/hr) for serverless runs, used with data-volume-based estimation. Rough guide: DBU rate × expected DBUs/hour for your workload |
| `catalystops.cost.queryBillingUsage` | `false` | After each serverless dry run, submit a background job that queries `system.billing.usage` to fetch actual DBU consumption and show the real cost. Requires Unity Catalog System Tables |
| `catalystops.billing.warehouseId` | `""` | SQL warehouse ID to use for billing queries. Leave blank to auto-discover (prefers running serverless warehouse) |
| `catalystops.debug` | `false` | Log equivalent curl commands and diagnostic details to the Output panel |

---

## Cost Estimation

### Static Annotation-Based Estimation

Add `# @compute:` and `# @size:` annotations to get an instant estimate without a cluster:

```python
# @compute: nodes=4, cores=2, memory=16GB, rate=0.25, overhead=2.0

events = spark.read.parquet("s3://bucket/events")  # @size: 50GB
lookup = spark.read.csv("s3://bucket/lookup")       # @size: 200MB
```

The estimate appears as a CodeLens above the `# @compute:` line and in the sidebar panel. The `overhead` factor (default `2.0`) multiplies the raw scan estimate to model the full notebook cost including transforms, shuffles, and writes.

### Cluster Dry-Run Estimation

After each dry run, CatalystOps estimates the cost of the analysis using the best available signal:

| Strategy | When used | How |
|----------|-----------|-----|
| **Actual DBU cost** | Serverless, `queryBillingUsage = true` | A background serverless notebook queries `system.billing.usage` for the completed run's DBU consumption. Billing data typically appears 1–5 minutes after the run; the notebook polls internally every 20 seconds for up to 5 minutes. The actual DBU total is multiplied by `serverlessRatePerHour` and shown in a separate toast notification. |
| **Data-volume heuristic** | Serverless | Estimates DBUs from total bytes scanned, cluster parallelism, and a Photon efficiency factor. Uses `serverlessRatePerHour` to convert to dollars. |
| **Cluster-time heuristic** | Interactive cluster | Measures elapsed wall-clock time of the dry run and multiplies by `dbuRatePerHour`. |

The estimated cost is reported in the analysis output and written to the Output panel (with full detail when `debug = true`).

> **Enabling actual cost reporting**: Set `catalystops.cost.queryBillingUsage = true` in your settings. Unity Catalog System Tables must be enabled on your workspace. Interactive cluster runs are billed continuously under the cluster ID and cannot be attributed per-command, so this setting applies to serverless runs only.

---

## Safety Model

The dry-run analysis **never executes Spark jobs or modifies data**. Before submission, the safety wrapper:

1. Replaces all action operations with `_catalystops_capture(df)` — a function injected into the script's namespace that captures the Catalyst plan without triggering execution
2. Drops multi-line streaming chains (`.writeStream...foreachBatch(...)...start()`) in full
3. Comments out lifecycle calls like `awaitTermination()` that would block execution

`_catalystops_capture(df)` captures the plan by temporarily redirecting stdout during `df.explain("formatted")`. This approach works on Databricks Runtime subclasses of DataFrame and on streaming DataFrames.

Local `.py` files imported by your script are automatically detected and bundled inline — no need to manually package dependencies.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│  Python file    │────▶│  Local Code Analyzer │──▶ 30+ anti-pattern checks
│  (active editor)│     │  (codeAnalyzer.ts)   │    with line/column positions
└─────────────────┘     └──────────┬───────────┘
                                   │
                         ┌─────────▼───────────┐
                         │  Schema Validator   │──▶ column-name + type checks
                         │  schemaExtractor.ts │    StructType / DDL schemas
                         │  schemaTracker.ts   │    propagated through transforms
                         │  schemaValidator.ts │    SCHEMA_COL/TYPE/ALIGN/JOIN
                         └─────────────────────┘    CODE_UNION/INTERSECT/EXCEPT_002
                                   │
                         ┌─────────▼───────────┐
                         │  Static Cost Est.   │──▶ # @compute: / # @size:
                         │  staticCostEstimator│    CodeLens + sidebar panel
                         └─────────────────────┘
                                   │
                                   ▼  (if Databricks configured)
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│  Safety Wrapper  │────▶│  Cluster Script  │────▶│  Databricks              │
│  neutralize      │     │  + local file    │     │  Jobs API (dry run)      │
│  writes/actions  │     │  bundling        │     │  cluster or serverless   │
└──────────────────┘     └──────────────────┘     └──────────┬───────────────┘
                                                             │  run_page_url → toast
                    ┌────────────────────┐                   │  "Open in Databricks"
                    │  Plan Parser       │◀──────────────────┘
                    │  Physical plan     │  joins, shuffles, cache,
                    │  Logical plan      │  repeated scans (incl. cross-DataFrame),
                    │  Photon-aware      │  spills, Photon node types
                    └────────┬───────────┘
                             │
              ┌──────────────▼──────────────┐     ┌──────────────────────────┐
              │  VS Code Diagnostics +      │     │  Billing Query (opt-in)  │
              │  Hover Cards + Tree View +  │     │  system.billing.usage    │
              │  Status Bar + HTML Report   │     │  → actual DBU cost toast │
              └──────────┬──────────────────┘     └──────────────────────────┘
                         │  updateMcpSnapshot()
              ┌──────────▼──────────────────┐
              │  MCP Server (in-process)    │──▶ Claude / Copilot / Cursor
              │  127.0.0.1:<port>/mcp       │    tools, resources, prompts
              └─────────────────────────────┘
```

---

## Development

### Prerequisites

- Node.js v16+
- VS Code v1.85.0+

### Build from Source

```bash
git clone https://github.com/lezwon/CatalystOps
cd CatalystOps
npm install
npm run build
# Extensions → Install from VSIX → select the generated .vsix
```

### Commands

```bash
npm run compile      # Compile TypeScript
npm run watch        # Watch mode (rebuild on save)
npm run build        # Production bundle via esbuild
npm run lint         # Type-check without emitting
npm test             # Run test suite
```

Press `F5` in VS Code to launch an Extension Development Host with breakpoint support in TypeScript source.

---

## Project Structure

```
catalyst-ops/
├── vscode/
│   ├── extension.ts              # Activation, command registration, local analysis loop
│   ├── telemetry.ts              # Azure Application Insights telemetry wrapper
│   ├── logger.ts                 # Output channel logger (debug-gated for diagnostics)
│   ├── analysis/
│   │   ├── codeAnalyzer.ts       # 30+ anti-pattern definitions + regex scanner
│   │   ├── schemaExtractor.ts    # Parses StructType / DDL schemas; continuation-line joining
│   │   ├── schemaTracker.ts      # Propagates schemas through DF transformations
│   │   ├── schemaValidator.ts    # Column-name, type, set-op, and join checks
│   │   ├── staticCostEstimator.ts # @compute / @size annotation parser + cost formula
│   │   ├── planParser.ts         # Catalyst plan → join/shuffle/cache/scan issues
│   │   ├── costModel.ts          # Heuristic cost scoring and DBU estimation
│   │   ├── clusterScript.ts      # Script generation, local file bundling, plan capture
│   │   ├── resultMapper.ts       # Maps plan issues to VS Code diagnostics
│   │   └── safetyWrapper.ts      # Neutralizes writes/actions for safe dry run
│   ├── databricks/
│   │   ├── client.ts             # Authenticated HTTP client for Databricks REST APIs
│   │   ├── clusterExecution.ts   # Interactive cluster command submission and polling
│   │   └── serverlessExecution.ts # Serverless job submission, polling, billing query
│   ├── billing/
│   │   ├── billingTypes.ts       # BillingRow / BillingSummary types, date-range helpers, computeSummary
│   │   ├── billingFetcher.ts     # SQL Statement Execution API, warehouse discovery, result parsing
│   │   └── billingCache.ts       # Local file cache (1-hour TTL) keyed by date range
│   ├── commands/
│   │   ├── analyzeCost.ts        # Full analysis orchestration
│   │   ├── analyzeSelection.ts   # Selection-scoped analysis
│   │   ├── showReport.ts         # HTML report generation
│   │   ├── configureConnection.ts
│   │   └── showBillingDashboard.ts # Billing orchestrator: cache → fetch → tree + webview
│   ├── providers/
│   │   ├── diagnosticsProvider.ts
│   │   ├── codeLensProvider.ts
│   │   ├── hoverProvider.ts      # Hover cards with quick-fix code blocks
│   │   └── codeActionProvider.ts
│   ├── mcp/
│   │   ├── mcpState.ts           # In-memory snapshot updated after each local analysis
│   │   └── server.ts             # MCP server: tools, resources, prompts; Streamable HTTP transport
│   └── views/
│       ├── statusBar.ts
│       ├── issuesTreeView.ts     # Sidebar tree with progress, cost, and write summaries
│       ├── billingTreeView.ts    # Billing sidebar tree (by user / job / workload)
│       └── billingWebview.ts     # Full billing dashboard (tabs, bar charts, daily trend)
├── test/
│   └── suite/
│       ├── codeAnalyzer.test.ts
│       ├── mcpState.test.ts      # MCP state snapshots + analyze_pyspark tool contract
│       ├── planParser.test.ts
│       ├── safetyWrapper.test.ts
│       ├── schemaValidator.test.ts
│       ├── staticCostEstimator.test.ts
│       └── billingTypes.test.ts  # dateRangeForPeriod, periodFromRange, computeSummary
└── media/
    └── icon.svg
```

---

## License

MIT — see [LICENSE](LICENSE)
