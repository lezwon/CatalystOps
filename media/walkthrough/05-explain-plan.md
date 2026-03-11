# Explain Plan & DAG

After a dry run, CatalystOps parses the Catalyst physical plan and surfaces it in two views.

---

## Explain Plan tree (sidebar)

Open the **CatalystOps** sidebar panel and expand **Explain Plan**.

Each DataFrame is shown as a group. Expand it to see the plan operators:

```
▼ orders_df  [2 issues]
    ⚠  SortMergeJoin  →  add broadcast hint
    ⚠  Exchange (HashPartitioning)  →  add repartition
    ✓  Filter
    ✓  FileScan delta catalog.sales.orders
```

**Inline quick fixes** appear as buttons next to flagged operators:
- `$(broadcast)` — adds `.hint("broadcast")` to the join
- `$(split-horizontal)` — inserts `.repartition(200)` before the shuffle
- `$(database)` — adds `.persist()` after a repeated scan
- `$(settings-gear)` — inserts AQE config at the top of the file

Clicking any node **jumps to the source line** in your editor.

---

## Plan DAG (visual graph)

Click the `$(type-hierarchy)` icon in the Explain Plan panel header, or run:

> **CatalystOps: Show Plan DAG**

The DAG opens beside your editor with color-coded nodes:

| Color | Meaning |
|---|---|
| 🔴 Red | Critical — CartesianProduct, unpartitioned write |
| 🟠 Orange | Warning — SortMergeJoin, Exchange |
| 🔵 Blue | Info — BroadcastHashJoin |
| 🟢 Green | OK — FileScan, Filter, Project |

Click any node in the DAG to jump to the corresponding source line.
