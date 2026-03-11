# Deep Analysis — Dry Run

A dry run submits a neutralized version of your code to Databricks, captures the Catalyst physical plan for every DataFrame, and surfaces issues that only appear at runtime.

---

## How to run

With a PySpark file open, press:

```
⌘⇧K  (macOS)
Ctrl+Shift+K  (Windows / Linux)
```

Or open the Command Palette and run **CatalystOps: Analyze Cost (Dry Run)**.

---

## What happens

1. **Local analysis** — 30+ rules run instantly
2. **Cluster check** — waits for the cluster to be ready
3. **Script generation** — local imports are bundled, actions are neutralized so the job exits early
4. **Execution** — the script runs on your cluster or serverless compute
5. **Plan capture** — `explain("formatted")` is collected for each DataFrame
6. **Results** — plan issues, cost estimate, and table stats appear inline

---

## What it finds beyond local analysis

| Issue | Example |
|---|---|
| SortMergeJoin instead of BroadcastHashJoin | Join where one side fits in memory |
| Exchange (shuffle) | `groupBy` on a high-cardinality key |
| Repeated FileScan | Same table read twice without `.cache()` |
| Missing table statistics | Optimizer picks a bad join order |
| Cartesian product confirmed | `CrossJoin` visible in physical plan |

---

## Cost estimate

After the run, CatalystOps shows an estimated dollar cost based on:
- **Serverless**: data volume scanned × rate
- **Cluster**: plan capture duration × core count × DBU rate
- **Fallback**: weighted issue severity score
