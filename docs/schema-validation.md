# Schema Validation

CatalystOps tracks DataFrame schemas across your file and validates column references and type usage at edit time — no cluster required.

## What Gets Validated

Schema validation activates when a `StructType` or DDL schema string is defined in the same file. CatalystOps extracts the schema and propagates it through transformations.

### Column Existence

Unknown column names are flagged with a "did you mean?" suggestion when a close match exists:

```python
schema = StructType([
    StructField("user_id", StringType()),
    StructField("event_ts", TimestampType()),
])

df = spark.createDataFrame(data, schema)
df.select("user_Id")   # ⚠ Unknown column — did you mean 'user_id'?
```

### Type Mismatches

Using a function that expects a specific type on an incompatible column:

```python
# event_ts is TimestampType, not a numeric type
df.filter(col("event_ts") > 100)   # ⚠ Type mismatch
```

### Union / Intersect Column Order

`union()` and `intersect()` align by position, not name. CatalystOps detects when the same column appears in different positions across two DataFrames — a silent wrong-result bug at runtime:

```python
a = spark.createDataFrame([], "id INT, name STRING")
b = spark.createDataFrame([], "name STRING, id INT")  # columns swapped

a.union(b)  # ⚠ Column order mismatch — 'id' aligns with 'name'
            # Use unionByName() instead
```

### Join Condition Types

Type mismatches in join keys:

```python
orders.join(users, orders["user_id"] == users["id"])
# ⚠ if user_id is STRING and id is INT
```

## Schema Propagation

Schemas are tracked through common transformations:

- `.filter()` — schema unchanged
- `.select()` — schema updated to selected columns
- `.drop()` — column removed from schema
- `.withColumn()` — column added or replaced
- `.withColumnRenamed()` — column renamed

## What Is Skipped

External sources without an explicit schema are skipped to avoid false positives:

```python
spark.table("my_catalog.my_table")   # skipped — schema unknown at edit time
spark.read.parquet("s3://...")        # skipped — no .schema() call
```

Add `.schema(your_schema)` to a read call for CatalystOps to validate downstream operations.
