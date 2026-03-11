# Welcome to CatalystOps

CatalystOps catches PySpark anti-patterns and Databricks cost issues — both instantly in your editor and deep inside the Catalyst execution plan.

---

## Two layers of analysis

| | Local Analysis | Dry Run |
|---|---|---|
| **Speed** | Instant | 10–60 sec |
| **Cluster needed** | No | Yes |
| **What it finds** | Anti-patterns in your code | Shuffle, join strategy, scan issues in the physical plan |
| **Cost estimate** | Heuristic | Data-volume or duration-based |

---

## What you'll set up in this walkthrough

1. See local analysis in action — no configuration needed
2. Connect to your Databricks workspace
3. Run a deep plan analysis (dry run)
4. Explore the Catalyst execution plan and DAG
5. Track Databricks spending in the billing dashboard
6. Use CatalystOps from Claude or Copilot via MCP
