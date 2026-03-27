# Billing Dashboard

The Billing Dashboard queries `system.billing.usage` in your Databricks workspace and shows spend broken down by user, job, and workload type.

## Prerequisites

- Unity Catalog **System Tables** must be enabled on your workspace
- A SQL warehouse to run the billing query (auto-discovered if blank; configure with `catalystops.billing.warehouseId`)
- Databricks connection configured (host + token)

## Opening the Dashboard

Run **CatalystOps: Show Billing Dashboard** from the Command Palette, or click **Show Dashboard** in the Billing sidebar panel.

On first open, CatalystOps asks for confirmation before running the SQL query against your warehouse — to avoid unexpected charges.

## Time Ranges

The dashboard supports four time ranges:

| Range | Description |
|-------|-------------|
| **Day** | Current calendar day |
| **Week** | Past 7 days |
| **Month** | Past 30 days |
| **Custom** | Date range picker |

## Caching

Results are cached for **1 hour** to avoid redundant warehouse queries. Click **Refresh** to force a live query at any time.

You can also run **CatalystOps: Refresh Billing Data** from the Command Palette.

## Actual Cost After Serverless Runs

Optionally, CatalystOps can query actual DBU consumption from `system.billing.usage` after each serverless dry run:

```jsonc
{
  "catalystops.cost.queryBillingUsage": true
}
```

This gives you a real cost figure instead of the estimated rate.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `catalystops.billing.warehouseId` | `""` | SQL warehouse ID (auto-discovered if blank) |
| `catalystops.cost.queryBillingUsage` | `false` | Query billing after each serverless run |
| `catalystops.cost.dbuRatePerHour` | `0.4` | DBU rate ($/hr) for cluster cost estimation |
| `catalystops.cost.serverlessRatePerHour` | `0.7` | Effective hourly cost for serverless estimation |
