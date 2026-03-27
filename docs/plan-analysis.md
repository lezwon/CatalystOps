# Plan Analysis & DAG

After a dry run, CatalystOps surfaces the physical Catalyst plan in an interactive sidebar tree and a full-page DAG webview.

## Explain Plan Tree

The **Explain Plan** sidebar panel shows the physical plan as a collapsible tree. Each node displays:

- Operator name (e.g. `BroadcastHashJoin`, `FileScan`, `Exchange`)
- Cost score — a normalized 0–100 value based on the operator's performance impact
- Issue badge when a plan-level problem is detected on that node
- Source line mapping (when available) to navigate back to the originating DataFrame

## DAG Webview

Click the **Show Plan DAG** button or run **CatalystOps: Show Plan DAG** from the Command Palette to open an interactive tree view:

- `└─` / `├─` connectors showing operator relationships
- Query groups collapsed into accordions with execution counts
- Filter conditions rendered in plain English (`col not null`, `a AND b`)
- Issue badges on affected nodes
- **View Source** button to jump to the notebook/file that generated the plan
- Collapsible **Raw Plans** section for debugging

## Quick Fixes on Plan Nodes

Right-click any plan node (or use the inline action buttons) for context-aware quick fixes:

| Fix | When Available | What It Does |
|-----|----------------|--------------|
| **Add Broadcast Hint** | Sort-merge join where one side is small | Inserts `broadcast()` on the smaller side |
| **Add Repartition** | Unnecessary exchange / skewed shuffle | Inserts `.repartition(200)` before the join or groupBy |
| **Add Persist** | Repeated scan of the same DataFrame | Inserts `df = df.persist()` after the assignment |
| **Enable AQE** | Sort-merge join that AQE could convert | Inserts `spark.conf.set("spark.sql.adaptive.enabled", "true")` at the top |
| **Add Join Condition** | Cartesian product | Prompts for a key name and replaces `.crossJoin()` with `.join()` |
