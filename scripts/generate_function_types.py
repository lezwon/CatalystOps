"""
generate_function_types.py
==========================
Probes every public PySpark SQL function against a typed test DataFrame and
emits `vscode/analysis/functionTypes.json` — the single source of truth for
the schema validator's type-mismatch checks.

Usage (requires a PySpark environment):
    python scripts/generate_function_types.py \
        > vscode/analysis/functionTypes.json

How it works
------------
For each function in `pyspark.sql.functions` we call it with a single-column
DataFrame of each Spark type and attempt `.schema` — which triggers Catalyst
analysis but never runs any computation.  If `AnalysisException` is raised the
type is rejected; otherwise it is accepted.

Accepted types are then collapsed into one of three categories:
  "numeric"  — integer | long | double | float | decimal
  "string"   — string
  "date"     — date | timestamp

Functions that accept everything (e.g. count, isnan) or nothing at all are
omitted from the output; the validator silently skips uncategorised functions.

Multi-argument functions
------------------------
Many functions (concat, locate, corr, …) have their column arg in a non-first
position, or accept multiple column args.  The probe calls them with a single
column arg first; for functions that require two column args it retries with
`func("v", "v")`.  Functions that only work on literals (rand, randn) are
handled by the "accepts nothing" filter and omitted automatically.
"""

import datetime
import inspect
import json
import sys

import pyspark.sql.functions as F
from pyspark.sql import SparkSession
from pyspark.sql.utils import AnalysisException

# ── Spark session ─────────────────────────────────────────────────────────────

spark = (
    SparkSession.builder
    .master("local[1]")
    .appName("generate_function_types")
    .config("spark.ui.enabled", "false")
    .config("spark.sql.shuffle.partitions", "1")
    .getOrCreate()
)
spark.sparkContext.setLogLevel("ERROR")

# ── Test DataFrames — one row, one column per type ───────────────────────────

TEST_FRAMES = {
    "integer":   spark.createDataFrame([(1,)],                        ["v"]),
    "long":      spark.createDataFrame([(1,)],                        ["v"]).select(F.col("v").cast("long").alias("v")),
    "double":    spark.createDataFrame([(1.5,)],                      ["v"]),
    "float":     spark.createDataFrame([(1.5,)],                      ["v"]).select(F.col("v").cast("float").alias("v")),
    "decimal":   spark.createDataFrame([(1,)],                        ["v"]).select(F.col("v").cast("decimal(10,2)").alias("v")),
    "string":    spark.createDataFrame([("hello",)],                  ["v"]),
    "boolean":   spark.createDataFrame([(True,)],                     ["v"]),
    "date":      spark.createDataFrame([(datetime.date.today(),)],    ["v"]),
    "timestamp": spark.createDataFrame([(datetime.datetime.now(),)],  ["v"]),
}

NUMERIC_TYPES = {"integer", "long", "double", "float", "decimal"}
STRING_TYPES  = {"string"}
DATE_TYPES    = {"date", "timestamp"}
ALL_TYPES     = set(TEST_FRAMES.keys())


# ── Probe helpers ─────────────────────────────────────────────────────────────

def _try_call(func, df, extra_args=()):
    """Return True if func("v", *extra_args) succeeds on df."""
    try:
        col_arg = F.col("v")
        args = (col_arg,) + tuple(extra_args)
        df.select(func(*args)).schema
        return True
    except Exception:
        return False


def accepted_types(func):
    """Return the set of type names accepted by func."""
    accepted = set()
    for type_name, df in TEST_FRAMES.items():
        # Try single-column call first; fall back to two-column call for
        # functions like corr/covar that require two column arguments.
        if _try_call(func, df) or _try_call(func, df, extra_args=(F.col("v"),)):
            accepted.add(type_name)
    return accepted


def categorise(accepted):
    """
    Map an accepted-type set to a category string, or None if it cannot be
    cleanly classified.
    """
    if not accepted or accepted == ALL_TYPES:
        return None   # accepts nothing useful, or accepts everything

    numeric_ok = accepted & NUMERIC_TYPES
    string_ok  = accepted & STRING_TYPES
    date_ok    = accepted & DATE_TYPES

    # Pure numeric (may accept all or some numeric subtypes)
    if numeric_ok and not string_ok and not date_ok:
        return "numeric"
    # Pure string
    if string_ok and not numeric_ok and not date_ok:
        return "string"
    # Pure date/timestamp
    if date_ok and not numeric_ok and not string_ok:
        return "date"
    return None


# ── Probe every public function ───────────────────────────────────────────────

# Functions that are not column-transforming or have special signatures
SKIP = {
    "col", "column", "lit", "typedLit",      # value constructors
    "struct", "array", "create_map",          # complex type constructors
    "when", "otherwise",                      # conditional builders
    "window", "WindowSpec",                   # window specs
    "pandas_udf", "udf",                      # UDF factories
    "lag", "lead", "rank", "dense_rank",      # window-only
    "ntile", "percent_rank", "cume_dist",     # window-only
    "row_number",                             # window-only
    "broadcast",                              # hint
    "expr", "callUDF",                        # dynamic SQL
    "from_json", "to_json", "schema_of_json", # schema-dependent
    "from_csv", "schema_of_csv",
    "explode", "explode_outer",               # array/map operations
    "posexplode", "posexplode_outer",
    "inline", "inline_outer",
    "arrays_zip", "flatten", "sequence",
    "map_keys", "map_values", "map_entries",  # map operations
    "element_at", "slice", "array_contains",  # container operations
    "transform", "filter", "aggregate",       # HOF
    "zip_with", "map_filter", "map_zip_with",
    "forall", "exists", "reduce",
}

results = {}

func_names = sorted(
    name for name in dir(F)
    if not name.startswith("_")
    and name not in SKIP
    and callable(getattr(F, name))
)

for func_name in func_names:
    func = getattr(F, func_name)
    try:
        sig = inspect.signature(func)
    except (ValueError, TypeError):
        continue

    params = [
        p for p in sig.parameters.values()
        if p.default is inspect.Parameter.empty
    ]
    # Skip functions with no required positional parameters
    if not params:
        continue

    try:
        acc = accepted_types(func)
        cat = categorise(acc)
        if cat:
            results[func_name] = cat
    except Exception:
        pass

# ── Output ────────────────────────────────────────────────────────────────────

print(json.dumps(results, sort_keys=True, indent=2))
spark.stop()
