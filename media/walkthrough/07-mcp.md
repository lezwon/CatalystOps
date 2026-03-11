# AI Integration via MCP

CatalystOps runs a local MCP (Model Context Protocol) server that exposes your analysis results to AI assistants — including Claude, GitHub Copilot, and any other MCP-compatible client.

---

## What the MCP server provides

**Tools** (actions the AI can invoke)
| Tool | What it does |
|---|---|
| `analyze_pyspark` | Runs local analysis on a code snippet |
| `get_active_file_issues` | Returns current file's issues |
| `run_dry_run` | Triggers a full dry run on the active file |
| `get_plan_analysis` | Returns the last captured plan + issues |
| `get_billing_summary` | Returns recent spend summary |
| `refresh_billing` | Fetches fresh billing data |

**Resources** (data the AI can read)
- `catalystops://issues/current` — live issues for the active file
- `catalystops://plans/last` — last dry-run physical plan
- `catalystops://billing/summary` — spend overview

---

## Setup

The MCP server starts automatically with the extension. In VS Code 1.99+, it is auto-discovered — no configuration needed.

For other clients, the port is logged to the **CatalystOps Output** panel on startup:

```
CatalystOps MCP server listening on 127.0.0.1:XXXXX/mcp
```

Add that URL to your MCP client's server list.

---

## Disabling

Set `catalystops.mcp.enabled` to `false` in settings and restart VS Code.
