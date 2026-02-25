# CatalystOps — PySpark Optimizer

**CatalystOps** catches PySpark performance issues before they hit production. It detects **30+ anti-patterns** locally in real time and runs **safe dry-run analysis** on a Databricks cluster or serverless compute to inspect Catalyst execution plans — all without executing Spark jobs or touching your data. Plan parsing is fully **Photon-aware** and detects cross-DataFrame repeated scans across your entire script.

> **Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=CatalystOps.catalystops)**

---

![CatalystOps Demo](https://iili.io/qFE28FV.gif)

## Why CatalystOps?

PySpark makes it easy to write code that *works* but runs slowly or expensively at scale. Common pitfalls — `collect()` on large DataFrames, cartesian joins, missing broadcast hints, repeated table scans, and cache misconfigurations — often slip past code review and only surface as runaway cluster bills.

CatalystOps gives you **two layers of analysis**:

- **Instant local checks** as you type — no cluster required
- **Deep plan analysis** on your actual Databricks cluster or serverless compute, parsing Catalyst physical and logical plans to catch issues that only appear at runtime

---

## Features

### Local Analysis (No Cluster Required)

Detects anti-patterns instantly via regex-based pattern matching with full comment-awareness:

| Severity | Checks |
|----------|--------|
| **Critical** | `collect()`, `crossJoin()`, SQL injection via f-strings in `spark.sql()` |
| **Warning** | UDFs, `toPandas()`, `coalesce(1)`, `repartition(1)`, `dropDuplicates()` without subset, `dropDuplicates` on streaming DataFrame (cross-batch stateful dedup), `withColumn` in loops, non-deterministic UDFs in UDFs, deprecated pandas `.append()`, `.rdd` conversion, unnecessary `count()`, `checkpoint()` (triggers HDFS write) |
| **Info** | Schema inference, chained `.filter()`, `show()` in production, `display()` in production, `cache()` without `unpersist()`, `select("*")`, global `orderBy`, missing write mode, `pandas_udf`, `to_pandas_on_spark()`, `Table May Lack Statistics` |

Each issue shows a **one-line explanation** and a **quick fix code block** on hover.

---

### Cluster Analysis — Catalyst Plan Inspection (Databricks Dry Run)

When a Databricks connection is configured, CatalystOps submits a neutralized version of your script to the cluster or serverless compute and parses both the **physical** and **analyzed logical** execution plans.

#### How it works — safely

1. **Safety wrapping** — writes, collects, streaming actions, and all action calls are neutralized so no data is modified or moved
2. **Plan capture** — a `_catalystops_capture(df)` call is injected in place of each action. This function captures the DataFrame's `explain("formatted")` output using stdout redirection, and works with streaming DataFrames and DataFrames defined inside functions
3. **Local file bundling** — imported local `.py` files are detected and inlined automatically
4. **Plan parsing** — physical and logical plans are analyzed for expensive patterns

#### Neutralized actions

| Original | Replacement |
|----------|-------------|
| `df.collect()` | `_catalystops_capture(df)` |
| `df.count()` | `_catalystops_capture(df)` |
| `df.show()` | `_catalystops_capture(df)` |
| `df.toPandas()` | `_catalystops_capture(df)` |
| `df.write.mode(...).save(...)` | `_catalystops_capture(df)` |
| `df.writeStream....start()` | `_catalystops_capture(df)` (full chain dropped) |
| `display(df)` | `_catalystops_capture(df)` |
| `query.awaitTermination()` | `# [CatalystOps: neutralized]` |

#### Join Detection

| Issue | What it means |
|-------|---------------|
| **Broadcast Hash Join** | Small table broadcast — efficient, no action needed |
| **Sort-Merge Join** | Both sides shuffled — consider broadcasting the smaller side |
| **Small Side Not Broadcast** | One side is small enough to broadcast but Spark chose sort-merge |
| **Shuffled Hash Join** | Consider broadcasting if the smaller side fits in executor memory |
| **Cartesian Product** | O(n×m) rows — catastrophically expensive, add a join condition |
| **Broadcast Nested Loop Join** | No join keys — iterating every row combination |
| **Broadcast Join → Single Partition Bottleneck** | Broadcast join immediately followed by a global aggregation |

#### Shuffle & Partition Detection

| Issue | What it means |
|-------|---------------|
| **Shuffle Exchange** | Data redistributed across partitions — minimize with caching or partition reuse |
| **Too Few Shuffle Partitions** | Very few output partitions → OOM risk and slow processing |
| **Default 200 Shuffle Partitions on Large Data** | `Exchange hashpartitioning(..., 200)` on a large dataset — suggests tuning `spark.sql.shuffle.partitions` or enabling AQE |

#### Cache & Persistence Detection

| Issue | What it means |
|-------|---------------|
| **Large DataFrame Cached** | A large DataFrame is being cached — suggests selecting only needed columns |
| **Cache Spilling to Disk** | Cached data has exceeded executor memory and is spilling — offers three remediation options |
| **Cache Using Deserialized Java Objects** | `MEMORY_ONLY` storage uses 3–5× more heap than Kryo-serialized storage |
| **Cached Relation Re-Scanned** | Same cached DataFrame read multiple times — restructure to reference once |
| **Cache Will Spill to Disk** | Cache size exceeds cluster memory estimate |

#### Read Efficiency Detection

| Issue | What it means |
|-------|---------------|
| **Same Source Scanned Multiple Times** | Physical or logical plan shows the same table/file scanned more than once — suggests caching after first read |
| **Same Table Scanned Across DataFrames** | The same source table appears in the physical plans of multiple DataFrames — read once and cache before reuse |
| **CSV Format — Use Parquet/Delta** | CSV disables columnar reads, predicate pushdown, and vectorised execution |
| **Missing Table Statistics** | Optimizer lacks statistics for join and partition decisions |
| **first() Without Ordering Guarantee** | Non-deterministic result in distributed execution |

> **AQE-aware**: CatalystOps correctly ignores the `== Initial Plan ==` section in Adaptive Query Execution plans to prevent false positives.

> **Photon-aware**: Join, shuffle, and scan detections cover Photon-native node types (`PhotonBroadcastHashJoin`, `PhotonSortMergeJoin`, `PhotonShuffledHashJoin`, `PhotonShuffleExchangeSink`, `PhotonShuffleExchangeSource`, `PhotonScan`) — ensuring accurate issue counts on Photon-accelerated clusters and serverless compute.

---

### Editor Integration

- **Inline diagnostics** — squiggly underlines with exact line/column positions, visible in the Problems panel
- **Hover tooltips** — clean markdown cards with a one-sentence explanation and a `Quick fix:` code block for every detected issue
- **CodeLens** — inline warnings above high-risk operations (`collect()`, `repartition(1)`, `coalesce(1)`, `checkpoint()`)
- **Quick Fix** actions (`⌘.` / `Ctrl+.`) — context-aware code suggestions
- **Issues tree view** — sidebar panel listing all local and dry-run issues by severity with line numbers
- **Progress steps** — live sidebar progress showing each analysis stage (local analysis → cluster check → script generation → cluster run → parsing)
- **Status bar** — real-time issue counts (critical / warning / info)
- **HTML reports** — shareable full analysis breakdown
- **Open in Databricks** — clickable button on analysis toast notifications linking directly to the Databricks run UI (shown when the run starts and again on completion)

---

## Getting Started

### Install from the VS Code Marketplace

Search for **CatalystOps** in the Extensions panel, or install directly:

```
ext install CatalystOps.catalystops
```

Local analysis works immediately after install — no configuration needed.

---

### Configure Databricks Connection (for dry-run plan analysis)

Run **CatalystOps: Configure Databricks Connection** from the Command Palette (`⌘⇧P`).

#### Option A — Interactive cluster

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi...",
  "catalystops.databricks.clusterId": "0123-456789-abcdef"
}
```

#### Option B — Serverless compute (no cluster needed)

Leave **Cluster ID blank** in the configuration wizard — CatalystOps automatically switches to serverless mode. Requires a Databricks Premium workspace.

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.executionMode": "serverless"
}
```

#### Option C — Databricks CLI config file

```jsonc
{
  "catalystops.databricks.configPath": "~/.databrickscfg",
  "catalystops.databricks.profile": "DEFAULT"
}
```

---

## Usage

| Command | Shortcut | Description |
|---------|----------|-------------|
| **CatalystOps: Analyze Cost (Dry Run)** | `⌘⇧K` / `Ctrl+Shift+K` | Run local + cluster analysis on the active file |
| **CatalystOps: Analyze Selected Code** | — | Analyze only the highlighted selection |
| **CatalystOps: Show Report** | — | Open a shareable HTML report of the last analysis |
| **CatalystOps: Configure Databricks Connection** | — | Interactive connection setup wizard |
| **CatalystOps: Show Generated Script** | — | View the full neutralized script sent to the cluster |
| **CatalystOps: Preview Dry-Run Script** | — | Preview only the neutralized user code (before submission) |

### Typical Workflow

1. Open a `.py` file — local analysis runs instantly
2. Review inline diagnostics and the Issues tree view in the sidebar
3. Hover over any underlined code for a detailed explanation and quick fix
4. Press `⌘⇧K` to run a deeper cluster-backed plan analysis
5. Apply fixes via Quick Fix (`⌘.`) or the hover card suggestions
6. Generate a shareable report with **Show Report**

---

## Settings Reference

| Setting | Default | Description |
|---------|---------|-------------|
| `catalystops.databricks.host` | `""` | Databricks workspace URL |
| `catalystops.databricks.token` | `""` | Personal access token (leave blank to use `.databrickscfg`) |
| `catalystops.databricks.clusterId` | `""` | Interactive cluster ID (leave blank to use serverless) |
| `catalystops.databricks.configPath` | `~/.databrickscfg` | Path to Databricks CLI config file |
| `catalystops.databricks.profile` | `DEFAULT` | Config profile name |
| `catalystops.databricks.executionMode` | `cluster` | `cluster` or `serverless` — auto-set to `serverless` when cluster ID is blank |
| `catalystops.analysis.autoAnalyzeOnSave` | `false` | Auto-analyze on save |
| `catalystops.analysis.enableLocalCodeAnalysis` | `true` | Enable local anti-pattern detection |
| `catalystops.cost.dbuRatePerHour` | `0.4` | DBU rate ($/hr) for interactive cluster cost estimation |
| `catalystops.cost.serverlessRatePerHour` | `0.7` | Effective hourly cost ($/hr) for serverless runs, used with data-volume-based estimation. Rough guide: DBU rate × expected DBUs/hour for your workload |
| `catalystops.cost.queryBillingUsage` | `false` | After each serverless dry run, submit a background job that queries `system.billing.usage` to fetch actual DBU consumption and show the real cost. Requires Unity Catalog System Tables |
| `catalystops.debug` | `false` | Log equivalent curl commands and diagnostic details to the Output panel |

---

## Cost Estimation

After each dry run, CatalystOps estimates the cost of the analysis using the best available signal:

| Strategy | When used | How |
|----------|-----------|-----|
| **Actual DBU cost** | Serverless, `queryBillingUsage = true` | A background serverless notebook queries `system.billing.usage` for the completed run's DBU consumption. Billing data typically appears 1–5 minutes after the run; the notebook polls internally every 20 seconds for up to 5 minutes. The actual DBU total is multiplied by `serverlessRatePerHour` and shown in a separate toast notification. |
| **Data-volume heuristic** | Serverless | Estimates DBUs from total bytes scanned, cluster parallelism, and a Photon efficiency factor. Uses `serverlessRatePerHour` to convert to dollars. |
| **Cluster-time heuristic** | Interactive cluster | Measures elapsed wall-clock time of the dry run and multiplies by `dbuRatePerHour`. |

The estimated cost is reported in the analysis output and written to the Output panel (with full detail when `debug = true`).

> **Enabling actual cost reporting**: Set `catalystops.cost.queryBillingUsage = true` in your settings. Unity Catalog System Tables must be enabled on your workspace. Interactive cluster runs are billed continuously under the cluster ID and cannot be attributed per-command, so this setting applies to serverless runs only.

---

## Safety Model

The dry-run analysis **never executes Spark jobs or modifies data**. Before submission, the safety wrapper:

1. Replaces all action operations with `_catalystops_capture(df)` — a function injected into the script's namespace that captures the Catalyst plan without triggering execution
2. Drops multi-line streaming chains (`.writeStream...foreachBatch(...)...start()`) in full
3. Comments out lifecycle calls like `awaitTermination()` that would block execution

`_catalystops_capture(df)` captures the plan by temporarily redirecting stdout during `df.explain("formatted")`. This approach works on Databricks Runtime subclasses of DataFrame and on streaming DataFrames.

Local `.py` files imported by your script are automatically detected and bundled inline — no need to manually package dependencies.

---

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│  Python file     │────▶│  Local Code Analyzer  │──▶ 30+ anti-pattern checks
│  (active editor) │     │  (codeAnalyzer.ts)    │    with line/column positions
└─────────────────┘     └──────────────────────┘
        │
        ▼  (if Databricks configured)
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
│  Safety Wrapper   │────▶│  Cluster Script   │────▶│  Databricks               │
│  neutralize       │     │  + local file     │     │  Jobs API (dry run)       │
│  writes/actions   │     │  bundling         │     │  cluster or serverless    │
└──────────────────┘     └──────────────────┘     └──────────┬────────────────┘
                                                             │  run_page_url → toast
                    ┌────────────────────┐                   │  "Open in Databricks"
                    │  Plan Parser       │◀──────────────────┘
                    │  Physical plan     │  joins, shuffles, cache,
                    │  Logical plan      │  repeated scans (incl. cross-DataFrame),
                    │  Photon-aware      │  spills, Photon node types
                    └────────┬───────────┘
                             │
              ┌──────────────▼──────────────┐     ┌──────────────────────────┐
              │  VS Code Diagnostics +       │     │  Billing Query (opt-in)   │
              │  Hover Cards + Tree View +   │     │  system.billing.usage     │
              │  Status Bar + HTML Report    │     │  → actual DBU cost toast  │
              └─────────────────────────────┘     └──────────────────────────┘
```

---

## Development

### Prerequisites

- Node.js v16+
- VS Code v1.85.0+

### Build from Source

```bash
git clone https://github.com/lezwon/CatalystOps
cd CatalystOps
npm install
npm run build
# Extensions → Install from VSIX → select the generated .vsix
```

### Commands

```bash
npm run compile      # Compile TypeScript
npm run watch        # Watch mode (rebuild on save)
npm run build        # Production bundle via esbuild
npm run lint         # Type-check without emitting
npm test             # Run test suite
```

Press `F5` in VS Code to launch an Extension Development Host with breakpoint support in TypeScript source.

---

## Project Structure

```
catalyst-ops/
├── vscode/
│   ├── extension.ts              # Activation, command registration, local analysis loop
│   ├── telemetry.ts              # Azure Application Insights telemetry wrapper
│   ├── logger.ts                 # Output channel logger (debug-gated for diagnostics)
│   ├── analysis/
│   │   ├── codeAnalyzer.ts       # 30+ anti-pattern definitions + regex scanner
│   │   ├── planParser.ts         # Catalyst plan → join/shuffle/cache/scan issues
│   │   ├── costModel.ts          # Heuristic cost scoring and DBU estimation
│   │   ├── clusterScript.ts      # Script generation, local file bundling, plan capture
│   │   ├── resultMapper.ts       # Maps plan issues to VS Code diagnostics
│   │   └── safetyWrapper.ts      # Neutralizes writes/actions for safe dry run
│   ├── databricks/
│   │   ├── client.ts             # Authenticated HTTP client for Databricks REST APIs
│   │   ├── clusterExecution.ts   # Interactive cluster command submission and polling
│   │   └── serverlessExecution.ts # Serverless job submission, polling, billing query
│   ├── commands/
│   │   ├── analyzeCost.ts        # Full analysis orchestration
│   │   ├── analyzeSelection.ts   # Selection-scoped analysis
│   │   ├── showReport.ts         # HTML report generation
│   │   └── configureConnection.ts
│   ├── providers/
│   │   ├── diagnosticsProvider.ts
│   │   ├── codeLensProvider.ts
│   │   ├── hoverProvider.ts      # Hover cards with quick-fix code blocks
│   │   └── codeActionProvider.ts
│   └── views/
│       ├── statusBar.ts
│       └── issuesTreeView.ts     # Sidebar tree with progress tracking
├── test/
│   └── suite/
│       ├── codeAnalyzer.test.ts
│       ├── planParser.test.ts
│       └── safetyWrapper.test.ts
└── media/
    └── icon.svg
```

---

## License

MIT — see [LICENSE](LICENSE)
