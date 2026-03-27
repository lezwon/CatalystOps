# Static Cost Estimation

Get an instant dollar estimate for a PySpark script without running it — by annotating your file with compute and data size hints.

## Annotations

Add a `# @compute` comment anywhere in the file to describe your cluster, and `# @size` comments on read operations to describe data sizes:

```python
# @compute: nodes=4, cores=2, memory=16GB, rate=0.25

events = spark.read.parquet("s3://bucket/events")   # @size: 50GB
lookup = spark.read.csv("s3://bucket/lookup")        # @size: 200MB
```

CatalystOps shows the estimated cost inline via CodeLens above the `# @compute` annotation.

## Compute Parameters

| Parameter | Description |
|-----------|-------------|
| `nodes` | Number of worker nodes |
| `cores` | vCPUs per node |
| `memory` | RAM per node (e.g. `16GB`) |
| `rate` | DBU rate in $/hr |

## Size Parameters

`# @size` accepts values like `50GB`, `200MB`, `1TB`. Place it at the end of the line with the `spark.read` call.

## DBU Rate

The default DBU rate comes from `catalystops.cost.dbuRatePerHour` (default `0.4`). Override it per-file with the `rate` parameter in `# @compute`.
