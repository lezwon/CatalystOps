# Welcome to CatalystOps

CatalystOps catches PySpark anti-patterns and Databricks cost issues — both instantly in your editor and deep inside the Catalyst execution plan.

---

## Four layers of analysis

| | Local Analysis | Dry Run | Job Run Analysis |
|---|---|---|---|
| **Speed** | Instant | 10–60 sec | 15–60 sec |
| **Cluster needed** | No | Yes | No (reads past logs) |
| **What it finds** | 40+ anti-patterns in your code | Shuffle, join strategy, scan issues in the physical plan | Same plan analysis on real production data |
| **Cost estimate** | Heuristic | Data-volume or duration-based | From cluster duration |
| **Source mapping** | ✅ Live | ✅ Active file | ✅ Downloads source from workspace |

---

## What you'll set up in this walkthrough

1. See local analysis in action — no configuration needed
2. Connect to your Databricks workspace
3. Run a deep plan analysis (dry run)
4. Explore the Catalyst execution plan and DAG
5. Analyze a historical job run from the Jobs sidebar
6. Track Databricks spending in the billing dashboard
7. Use CatalystOps from Claude or Copilot via MCP
