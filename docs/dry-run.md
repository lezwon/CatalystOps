# Dry Run

The dry run submits a neutralized version of your script to Databricks and captures the physical Catalyst execution plan — without touching any data.

## How It Works

Press `⌘⇧K` (`Ctrl+Shift+K`) to trigger a dry run on the active file. CatalystOps:

1. **Neutralizes** the script — all writes, actions, and side-effects are replaced with `explain("formatted")` captures. No data is read beyond plan generation, and nothing is written.
2. **Submits** the script to your configured execution target.
3. **Parses** the returned physical plans and surfaces issues with cost annotations in the sidebar.
4. **Maps** issues back to source lines where possible.

## Execution Modes

### Interactive Cluster

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi...",
  "catalystops.databricks.clusterId": "0123-456789-abcdef",
  "catalystops.databricks.executionMode": "cluster"
}
```

The script is submitted via the Databricks Command Execution API and runs on the cluster's existing Spark session. Fastest for iterative development.

### Serverless

```jsonc
{
  "catalystops.databricks.executionMode": "serverless"
}
```

Leave `clusterId` blank. Databricks spins up serverless compute for each run. No cluster management required, but cold-start adds latency. Requires Databricks Premium tier.

### SSH Tunnel

```jsonc
{
  "catalystops.connection.sshTunnel.enabled": true,
  "catalystops.connection.sshTunnel.connectionName": "my-cluster"
}
```

The script runs directly on the cluster driver over an SSH tunnel — useful when your workspace is behind a firewall or you need to test with a specific environment. Requires Databricks CLI ≥ 0.269 and DBR 17+.

## Plan Issues Detected

| Issue | Description |
|-------|-------------|
| **BroadcastHashJoin (missing)** | Sort-merge join where one side is small enough to broadcast |
| **CartesianProduct** | Cartesian join detected in the physical plan |
| **ShuffleExchange** | Unnecessary shuffle that could be eliminated |
| **SinglePartitionBottleneck** | `Exchange SinglePartition` — all data funnelled to one executor |
| **SortAggregate** | Sort-based aggregation (slower than hash-based, prone to spill) |
| **GlobalWindow** | Window function without partition key — full dataset on one node |
| **RepeatedTableScan** | Same table scanned multiple times; add `.cache()` |
| **MissingPartitionFilter** | Partition filters are empty — reading all partitions |
| **MissingTableStatistics** | Table has no statistics; query planner may make poor join decisions |
| **CacheSpill** | Cached data spills to disk due to insufficient memory |
| **TooFewPartitions** | Parallelism too low for data size |

All detectors are Photon-aware and handle AQE initial plans.

## Timeout

Default timeout is 300 seconds. Adjust with:

```jsonc
{
  "catalystops.dryRun.timeoutSeconds": 600
}
```

Minimum is 30 seconds.

## Preview the Script

Before submitting, you can inspect the neutralized script with **CatalystOps: Preview Dry Run Script** from the Command Palette. This shows exactly what will be sent to Databricks — useful for debugging unexpected plan results.

## Auto-Analyze on Save

Automatically trigger a dry run whenever you save the file:

```jsonc
{
  "catalystops.analysis.autoAnalyzeOnSave": true
}
```

Note: the full dry run (Databricks execution) always requires a cluster connection. Local checks always run automatically regardless of this setting.
