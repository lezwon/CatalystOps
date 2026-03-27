# Local Analysis

CatalystOps runs 40+ anti-pattern checks on every Python file open and save — no cluster, no network call, no configuration required.

## How It Works

When you open or edit a `.py` file, CatalystOps:

1. Scans the code with regex-based pattern matchers
2. Flags issues inline as VS Code diagnostics (squiggly underlines)
3. Shows a hover card with a one-sentence explanation and a quick-fix snippet
4. Updates the **Issues** sidebar with a full list

Analysis also runs on Jupyter notebooks (`.ipynb`) — each cell is analyzed in context and issues are mapped back to the correct cell.

## Severity Levels

| Level | Color | Meaning |
|-------|-------|---------|
| **Critical** | Red | Will likely cause OOM, data loss, or incorrect results |
| **Warning** | Yellow | Performance problem that will hurt at scale |
| **Info** | Blue | Best-practice recommendation |
| **Suggestion** | Grey | Minor improvement opportunity |

## Suppressing a Rule

Add `# noqa: catalystops` to any line to suppress all rules on that line:

```python
df.collect()  # noqa: catalystops
```

## Rule Categories

### Spark Actions

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_COLLECT_001` | Critical | `collect()` pulls all data to the driver — OOM risk on large datasets |
| `CODE_PANDAS_001` | Warning | `toPandas()` brings all data to the driver |
| `CODE_COUNT_001` | Warning | `count() > 0` triggers a full Spark job; use `isEmpty()` instead |
| `CODE_ITER_COLLECT_001` | Critical | `for row in df.collect()` iterates row-by-row on the driver |

### Joins

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_CROSSJOIN_001` | Critical | `crossJoin()` or implicit cartesian product |
| `CODE_COALESCE_001` | Warning | `coalesce(1)` funnels all data to one partition |

### Shuffles & Partitioning

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_ORDERBY_001` | Warning | Global `orderBy()` / `sort()` triggers a full shuffle |
| `CODE_REPARTITION_001` | Warning | `repartition(N)` before a write — use `coalesce()` to avoid the full shuffle |
| `CODE_WINDOW_001` | Warning | `Window.orderBy()` without `partitionBy()` — global window, single partition |

### DataFrame Operations

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_WITHCOLUMN_LOOP_001` | Warning | `withColumn()` inside a loop creates a new plan node per iteration |
| `CODE_REPEATED_ACTIONS_001` | Warning | Multiple actions on the same DataFrame without `.cache()` |
| `CODE_REPRO_001` | Info | Repeated source scan without `.cache()` or `.persist()` |

### UDFs

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_UDF_001` | Info | Python UDF prevents query plan optimization |
| `CODE_UDF_FILTER_001` | Warning | UDF inside `.filter()` blocks predicate pushdown on Delta/partitioned tables |

### Schema & Reads

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_SCHEMA_001` | Info | `inferSchema=true` requires an extra data pass; provide an explicit schema |
| `CODE_SELECT_STAR_001` | Info | `SELECT *` may read unnecessary columns |
| `CODE_WRITE_MODE_001` | Info | Missing `.mode()` on write — defaults to `error`, will fail if data exists |

### Security

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_SQL_INJECT_001` | Critical | f-string interpolation in `spark.sql()` — SQL injection risk |
| `CODE_KAFKA_COMMIT_001` | Critical | Kafka auto-commit enabled — can cause data loss or duplication |

### Streaming

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_STREAMING_TRIGGER_001` | Warning | No `.trigger()` — runs continuous micro-batches |
| `CODE_STREAMING_WATERMARK_001` | Warning | `groupBy()` without watermark causes unbounded state accumulation |
| `CODE_STREAMING_INNER_JOIN_001` | Warning | Streaming inner join silently drops late events |
| `CODE_DYNAMIC_ALLOC_001` | Warning | Dynamic allocation on a streaming cluster causes instability |
| `CODE_ROCKSDB_001` | Info | Stateful streaming without RocksDB state store |
| `CODE_AUTOLOADER_RATE_001` | Warning | Auto Loader without `maxBytesPerTrigger` — unbounded ingestion rate |
| `CODE_CHECKPOINT_DBFS_001` | Warning | Checkpoint stored on DBFS — use cloud storage for reliability |
| `CODE_UNNAMED_QUERY_001` | Info | Streaming query has no name — harder to monitor |

### Delta Lake

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_MERGE_DV_001` | Info | MERGE without Deletion Vectors enabled |
| `CODE_MERGE_RLC_001` | Info | MERGE without Row-Level Concurrency |
| `CODE_OPTIMIZE_MERGE_001` | Warning | `OPTIMIZE` after every MERGE causes latency spikes |
| `CODE_DROP_CREATE_001` | Warning | `DROP TABLE` + `CREATE TABLE` is non-atomic; use `CREATE OR REPLACE` |
| `CODE_ZORDER_001` | Info | ZORDER is deprecated for new tables; use Liquid Clustering |
| `CODE_ANALYZE_001` | Info | Missing `ANALYZE TABLE` after large writes — statistics may be stale |
| `CODE_FLOAT_FINANCIAL_001` | Warning | FLOAT/DOUBLE for financial columns loses precision; use DECIMAL |

### DLT Pipelines

| Rule ID | Severity | Description |
|---------|----------|-------------|
| `CODE_DLT_PARTITION_001` | Info | DLT `PARTITIONED BY` / `partition_cols` — prefer Liquid Clustering |
| `CODE_DLT_CDC_ORDER_001` | Critical | `APPLY AS DELETE WHEN` in wrong clause order causes incorrect CDC |
| `CODE_READ_FILES_SCHEMA_001` | Info | `read_files()` without `schemaHints` — schema inference on every run |
