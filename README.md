# CatalystOps

A VS Code extension that catches PySpark performance issues before they hit production. It detects **23 anti-patterns** locally in real time and optionally runs **dry-run analysis** on a Databricks cluster to parse Catalyst execution plans and score query cost — all without executing any actual Spark jobs.

---

## Why CatalystOps?

PySpark makes it easy to write code that works but runs slowly or expensively at scale. Common pitfalls like `collect()` on large DataFrames, cartesian joins, UDF overhead, and missing write modes often slip past code review. CatalystOps surfaces these issues as you type, with severity ratings, explanations, and suggested fixes.

## Features

### Local Analysis (No Cluster Required)

Detects anti-patterns instantly via regex-based pattern matching with comment-awareness:

| Severity | Anti-patterns |
|----------|--------------|
| **Critical** | `collect()`, `crossJoin()`, SQL injection in `spark.sql()` |
| **Warning** | UDFs, `toPandas()`, `coalesce(1)`, `repartition(1)`, `dropDuplicates()` without subset, `withColumn` in loops, non-deterministic UDFs, deprecated `.append()`, `.rdd` conversion, unnecessary `count()` |
| **Info** | Schema inference, chained `.filter()`, `show()`, `display()`, `cache()` without `unpersist()`, `select("*")`, global `orderBy`, missing write mode, `pandas_udf`, `to_pandas_on_spark()` |

Each issue includes a description, suggested fix, and replacement code snippet.

### Cluster Analysis (Databricks Dry Run)

When a Databricks connection is configured, CatalystOps performs deep analysis:

1. **Safety wrapping** — writes, collects, and actions are replaced with `explain("formatted")` so no data is modified
2. **Execution plan parsing** — detects join types (BroadcastHash, SortMerge, CartesianProduct, BroadcastNestedLoop), shuffle exchanges, missing statistics, and predicate pushdown gaps
3. **Heuristic cost scoring** — assigns points by operation type (CartesianProduct = 1000, SortMergeJoin = 50, shuffle = 20, etc.) and severity, then labels the total as Optimal / Low / Moderate / High / Critical

### Editor Integration

- **Inline diagnostics** in the Problems panel with exact line/column positions
- **CodeLens** actions above PySpark operations
- **Hover tooltips** with anti-pattern explanations
- **Quick Fix** code actions (⌘.)
- **Issues tree view** in the activity bar sidebar for organized navigation
- **Status bar** showing live issue counts (critical / warning / info)
- **HTML reports** with full analysis breakdown

---

## Getting Started

### Install

Install from the VS Code Marketplace, or build from source:

```bash
npm install
npm run build
# Then: Extensions → Install from VSIX
```

### Configure (Optional — for cluster analysis)

Run **CatalystOps: Configure Databricks Connection** from the command palette, or add to `settings.json`:

```jsonc
{
  // Databricks connection
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi...",
  "catalystops.databricks.clusterId": "0123-456789-abcdef",

  // Or use a Databricks config file
  "catalystops.databricks.configPath": "~/.databricks/config",
  "catalystops.databricks.profile": "DEFAULT",

  // Behavior
  "catalystops.analysis.autoAnalyzeOnSave": false,
  "catalystops.analysis.enableLocalCodeAnalysis": true,
  "catalystops.cluster.installSparkOptimizer": true
}
```

Local analysis works immediately with no configuration.

---

## Usage

| Command | Shortcut | Description |
|---------|----------|-------------|
| **CatalystOps: Analyze Cost (Dry Run)** | `⌘⇧K` / `Ctrl+Shift+K` | Run local + cluster analysis on the active file |
| **CatalystOps: Analyze Selected Code** | — | Analyze only the highlighted code |
| **CatalystOps: Show Report** | — | Open an HTML report of the last analysis |
| **CatalystOps: Configure Databricks Connection** | — | Interactive connection setup |

### Typical Workflow

1. Open a `.py` file — local analysis runs automatically as you type
2. Review inline diagnostics and the Issues tree view
3. Press `⌘⇧K` for deeper cluster-backed analysis
4. Apply suggested fixes via Quick Fix (⌘.)
5. Generate a shareable report with **Show Report**

---

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐
│  Python file     │────▶│  Local Code Analyzer  │──▶ 23 anti-pattern checks
│  (active editor) │     │  (codeAnalyzer.ts)    │    with line/column positions
└─────────────────┘     └──────────────────────┘
        │
        ▼  (if Databricks configured)
┌──────────────────┐     ┌──────────────────┐     ┌──────────────┐
│  Safety Wrapper   │────▶│  Cluster Script   │────▶│  Databricks   │
│  neutralize       │     │  generation       │     │  Command API  │
│  writes/actions   │     │  (clusterScript)  │     │  (dry run)    │
└──────────────────┘     └──────────────────┘     └──────┬───────┘
                                                         │
                    ┌────────────────────┐               │
                    │  Plan Parser       │◀──────────────┘
                    │  (planParser.ts)   │
                    └────────┬───────────┘
                             │
                    ┌────────▼───────────┐
                    │  Cost Model        │──▶ Heuristic cost score
                    │  (costModel.ts)    │    (Optimal → Critical)
                    └────────────────────┘
                             │
              ┌──────────────▼──────────────┐
              │  VS Code Diagnostics +       │
              │  Tree View + Status Bar +    │
              │  HTML Report                 │
              └─────────────────────────────┘
```

### Safety Model

The dry-run analysis **never executes Spark jobs or modifies data**. The safety wrapper replaces all action operations (`.write`, `.collect()`, `.count()`, `.show()`, `.toPandas()`) with `.explain("formatted")` calls, so only Catalyst plan metadata is retrieved from the cluster.

---

## Project Structure

```
catalyst-ops/
├── vscode/
│   ├── extension.ts              # Activation, command registration, local analysis loop
│   ├── analysis/
│   │   ├── codeAnalyzer.ts       # 23 anti-pattern definitions + regex scanner
│   │   ├── planParser.ts         # Catalyst plan → join/shuffle/stats issues
│   │   ├── costModel.ts          # Heuristic cost scoring
│   │   ├── clusterScript.ts      # Script generation for cluster execution
│   │   ├── resultMapper.ts       # Maps results to VS Code diagnostics
│   │   └── safetyWrapper.ts      # Neutralizes writes/actions for dry run
│   ├── commands/
│   │   ├── analyzeCost.ts        # Full analysis orchestration
│   │   ├── analyzeSelection.ts   # Selection-scoped analysis
│   │   ├── showReport.ts         # HTML report generation
│   │   └── configureConnection.ts
│   ├── config/
│   │   ├── databricksConfig.ts   # Config file parsing
│   │   └── settings.ts           # VS Code settings accessor
│   ├── databricks/
│   │   └── client.ts             # Databricks REST API client
│   ├── models/
│   │   └── types.ts              # Shared interfaces and enums
│   ├── providers/
│   │   ├── diagnosticsProvider.ts
│   │   ├── codeLensProvider.ts
│   │   ├── hoverProvider.ts
│   │   └── codeActionProvider.ts
│   └── views/
│       ├── statusBar.ts
│       └── issuesTreeView.ts
├── test/
│   └── suite/
│       ├── codeAnalyzer.test.ts
│       ├── planParser.test.ts
│       └── safetyWrapper.test.ts
├── media/
│   └── catalystops.css
├── package.json
├── tsconfig.json
└── esbuild.js                    # Production bundler
```

## Development

### Prerequisites

- Node.js v16+
- VS Code v1.85.0+

### Commands

```bash
npm install          # Install dependencies
npm run compile      # Compile TypeScript
npm run watch        # Watch mode (rebuild on save)
npm run build        # Production bundle via esbuild
npm run lint         # Type check without emitting
npm test             # Run test suite
```

### Debugging

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded. Breakpoints work in the TypeScript source files.

### Tests

```bash
npm test
```

Covers code analyzer pattern matching, plan parsing, and safety wrapper transformations.
