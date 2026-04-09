# Historical Job Run Analysis

Open the **Jobs** panel in the CatalystOps sidebar. Click any job to analyze its last run — no re-execution needed.

CatalystOps reads the Spark event log from DBFS, extracts physical plans, and opens an interactive DAG view with issue badges per node.

**Requires:** cluster log delivery to DBFS enabled on the cluster.
