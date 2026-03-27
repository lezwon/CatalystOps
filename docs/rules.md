# All Rules Reference

This page lists every rule CatalystOps checks. For context and fix examples, see [Local Analysis](/local-analysis) and [Plan Analysis](/plan-analysis).

## Static Code Rules

### Critical

| Rule ID | Name | Description |
|---------|------|-------------|
| `CODE_COLLECT_001` | collect() Usage | Brings all data to the driver — OOM risk |
| `CODE_ITER_COLLECT_001` | for-loop over collect() | Row-by-row iteration on the driver |
| `CODE_CROSSJOIN_001` | Cross Join | Cartesian product — exponential data growth |
| `CODE_SQL_INJECT_001` | SQL Injection | f-string in spark.sql() |
| `CODE_KAFKA_COMMIT_001` | Kafka Auto-Commit | Can cause data loss or duplication |
| `CODE_DLT_CDC_ORDER_001` | DLT CDC Clause Order | APPLY AS DELETE WHEN in wrong order |

### Warning

| Rule ID | Name | Description |
|---------|------|-------------|
| `CODE_PANDAS_001` | toPandas() | Brings all data to driver |
| `CODE_COUNT_001` | count() > 0 | Use isEmpty() instead |
| `CODE_COALESCE_001` | coalesce(1) | Funnels all data to one partition |
| `CODE_ORDERBY_001` | Global orderBy | Full shuffle |
| `CODE_REPARTITION_001` | repartition before write | Use coalesce() |
| `CODE_WINDOW_001` | Window without partitionBy | Global window |
| `CODE_WITHCOLUMN_LOOP_001` | withColumn in loop | New plan node per iteration |
| `CODE_REPEATED_ACTIONS_001` | Repeated actions without cache | Recomputes the DataFrame |
| `CODE_UDF_FILTER_001` | UDF in filter() | Blocks predicate pushdown |
| `CODE_STREAMING_TRIGGER_001` | No .trigger() | Continuous micro-batches |
| `CODE_STREAMING_WATERMARK_001` | Streaming groupBy without watermark | Unbounded state |
| `CODE_STREAMING_INNER_JOIN_001` | Streaming inner join | Silently drops late events |
| `CODE_DYNAMIC_ALLOC_001` | Dynamic allocation on streaming | Cluster instability |
| `CODE_AUTOLOADER_RATE_001` | Auto Loader without rate limit | Unbounded ingestion |
| `CODE_CHECKPOINT_DBFS_001` | Checkpoint on DBFS | Use cloud storage |
| `CODE_OPTIMIZE_MERGE_001` | OPTIMIZE after every MERGE | Latency spikes |
| `CODE_DROP_CREATE_001` | DROP + CREATE TABLE | Non-atomic, use CREATE OR REPLACE |
| `CODE_FLOAT_FINANCIAL_001` | FLOAT for financial data | Use DECIMAL |

### Info

| Rule ID | Name | Description |
|---------|------|-------------|
| `CODE_UDF_001` | UDF Usage | Prevents query plan optimization |
| `CODE_SCHEMA_001` | Schema Inference | Extra data pass |
| `CODE_SELECT_STAR_001` | SELECT * | Reads unnecessary columns |
| `CODE_WRITE_MODE_001` | Missing write mode | Defaults to error |
| `CODE_REPRO_001` | Repeated source without cache | Multiple scans |
| `CODE_ROCKSDB_001` | Stateful streaming without RocksDB | State store performance |
| `CODE_UNNAMED_QUERY_001` | Unnamed streaming query | Hard to monitor |
| `CODE_MERGE_DV_001` | MERGE without Deletion Vectors | Performance on large tables |
| `CODE_MERGE_RLC_001` | MERGE without Row-Level Concurrency | Concurrency issues |
| `CODE_ZORDER_001` | ZORDER | Deprecated; use Liquid Clustering |
| `CODE_ANALYZE_001` | Missing ANALYZE TABLE | Stale statistics |
| `CODE_DLT_PARTITION_001` | DLT PARTITIONED BY | Use Liquid Clustering |
| `CODE_READ_FILES_SCHEMA_001` | read_files() without schemaHints | Schema inference per run |

## Plan-Level Detectors

These run after a dry run or job run analysis and require an actual Catalyst execution plan:

| Name | Description |
|------|-------------|
| `BroadcastHashJoin` (missing) | Sort-merge join where broadcast would be faster |
| `CartesianProduct` | Cartesian join in the physical plan |
| `ShuffleExchange` | Unnecessary shuffle |
| `SinglePartitionBottleneck` | Exchange SinglePartition — all data on one executor |
| `SortAggregate` | Sort-based aggregation (prefer hash-based) |
| `GlobalWindow` / `RunningWindowFunction` | Global window, Photon-aware |
| `RepeatedTableScan` | Same table scanned multiple times |
| `MissingPartitionFilter` | Partition filters empty — full table scan |
| `MissingTableStatistics` | Table has no statistics |
| `CacheSpill` | Cached data spilling to disk |
| `TooFewPartitions` | Low parallelism for data size |
| `CrossJoin` | Cartesian join (also caught by local analysis) |
| `UnionSchemaMismatch` | Column order mismatch (also caught by local analysis) |
