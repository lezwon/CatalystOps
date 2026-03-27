# Settings Reference

All CatalystOps settings are prefixed with `catalystops.`.

## Databricks Connection

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.databricks.host` | string | `""` | Databricks workspace URL (e.g. `https://myworkspace.cloud.databricks.com`) |
| `catalystops.databricks.token` | string | `""` | Personal access token (`dapi...`) |
| `catalystops.databricks.clusterId` | string | `""` | Interactive cluster ID — leave blank for serverless |
| `catalystops.databricks.executionMode` | `cluster` \| `serverless` | `cluster` | Execution mode for dry-run analysis |
| `catalystops.databricks.configPath` | string | `~/.databrickscfg` | Path to Databricks CLI config file |
| `catalystops.databricks.profile` | string | `DEFAULT` | Profile name in the config file |

## SSH Tunnel

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.connection.sshTunnel.enabled` | boolean | `false` | Use SSH tunnel for dry-run execution |
| `catalystops.connection.sshTunnel.connectionName` | string | `""` | SSH alias from `databricks ssh setup` |
| `catalystops.ssh.shutdownDelay` | string | `30m` | Cluster idle time before SSH tunnel closes |

## Analysis

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.analysis.enableLocalCodeAnalysis` | boolean | `true` | Enable local anti-pattern detection |
| `catalystops.analysis.enableRepeatedScanDetection` | boolean | `false` | Warn when a source DataFrame is reused without `.cache()` |
| `catalystops.analysis.autoAnalyzeOnSave` | boolean | `false` | Auto-run dry run on save |
| `catalystops.dryRun.timeoutSeconds` | number | `300` | Max seconds to wait for a dry-run job (minimum 30) |

## Jobs

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.jobs.enabled` | boolean | `true` | Show the Jobs sidebar panel |

## Cost & Billing

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.cost.dbuRatePerHour` | number | `0.4` | DBU rate ($/hr) for cluster cost estimation |
| `catalystops.cost.serverlessRatePerHour` | number | `0.7` | Effective hourly cost for serverless estimation |
| `catalystops.cost.queryBillingUsage` | boolean | `false` | Query `system.billing.usage` after each serverless run for actual cost |
| `catalystops.billing.warehouseId` | string | `""` | SQL warehouse ID for billing queries (auto-discovered if blank) |

## MCP

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.mcp.enabled` | boolean | `true` | Enable the built-in MCP server |

## Debug

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `catalystops.debug` | boolean | `false` | Log diagnostic details to the Output panel |
