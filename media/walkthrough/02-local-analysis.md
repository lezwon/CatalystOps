# Instant Local Analysis

CatalystOps starts analyzing your code the moment you open a `.py` file — no cluster, no configuration.

---

## What it detects

**Joins**
- Cartesian products (`crossJoin`, missing join condition)
- Large-to-large joins that should use a broadcast hint
- Sort-merge joins that AQE can't optimize

**Data movement**
- Unnecessary shuffles via `repartition` / `coalesce`
- Wide transformations followed by wide aggregations

**UDFs**
- Python UDFs that serialize data out of the JVM
- Row-by-row operations that can be replaced with native Spark functions

**Schema & I/O**
- Reading entire tables when only a few columns are needed
- Writing without partitioning on high-cardinality columns
- Missing `.cache()` / `.persist()` on DataFrames scanned multiple times

**Streaming**
- `foreachBatch` misuse, unbounded watermarks

**Security**
- Hardcoded credentials and tokens in code

---

## Where results appear

- **Inline squiggles** — hover for a description and fix suggestion
- **Problems panel** — `View > Problems` (⇧⌘M)
- **CatalystOps sidebar** — Issues tree with severity grouping

30+ rules run on every file open and save.
