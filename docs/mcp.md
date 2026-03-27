# MCP Server

CatalystOps exposes a built-in **Model Context Protocol (MCP)** server that lets Claude, GitHub Copilot, Cursor, and any MCP-compatible client access live analysis data through natural language.

## Auto-Discovery

In VS Code 1.99+, the MCP server is discovered automatically via `vscode.lm.registerMcpServerDefinitionProvider`. No configuration needed — just install CatalystOps and the server is available to Copilot and Claude.

For other clients, add the URL shown in the CatalystOps Output panel:

```json
{
  "servers": {
    "catalystops": {
      "url": "http://127.0.0.1:<port>/mcp"
    }
  }
}
```

The port is dynamic and logged on extension startup.

## Enabling / Disabling

The MCP server is enabled by default. Disable it with:

```jsonc
{
  "catalystops.mcp.enabled": false
}
```

## Tools

| Tool | Description |
|------|-------------|
| `analyze_pyspark` | Run local static analysis on any PySpark code snippet |
| `get_active_file_issues` | Get issues for the currently open file |
| `get_plan_analysis` | Get plan issues from the last dry run |
| `run_dry_run` | Trigger a dry run on the active file and return results |
| `get_billing_summary` | Get cached billing data (day / week / month) |
| `refresh_billing` | Force a live billing query |
| `list_clusters` | List workspace clusters with state and Spark version |
| `list_job_runs` | List jobs and their most recent run status |
| `get_job_run_plan` | Fetch plan issues from a historical job run by ID |
| `get_last_job_run_analysis` | Get plan issues from the last job analyzed in VS Code |

## Resources

| URI | Description |
|-----|-------------|
| `catalystops://issues/current` | Issues for the active file |
| `catalystops://plans/last` | Last dry-run plan results |
| `catalystops://billing/summary` | Cached billing summary |

## Prompts

| Prompt | Description |
|--------|-------------|
| `pyspark_code_review` | Review the active file for PySpark performance issues |
| `optimize_spark_plan` | Analyze the last dry-run plan and suggest optimizations |

## Example Usage

```
You:    What issues are in my active file?
Claude: ↳ calling get_active_file_issues…
        Found 3 issues in pipeline.py:
        ● Line 12 — collect() pulls all data to the driver. OOM risk.
        ● Line 18 — Global orderBy shuffles all data to one partition.
        ● Line 31 — Streaming query has no .trigger() — continuous micro-batches.

You:    Run a dry run and tell me the join strategy
Claude: ↳ calling run_dry_run…
        The plan shows a Sort-Merge Join on line 8 — the right side
        (200MB) is below the broadcast threshold. Want me to add a broadcast hint?
```
