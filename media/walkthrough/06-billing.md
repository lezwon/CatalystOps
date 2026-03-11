# Track Databricks Costs

The billing dashboard shows your Databricks DBU usage and estimated spend — broken down by cluster, job, and time period.

---

## Opening the dashboard

Click the **Billing** tree in the CatalystOps sidebar, or run:

> **CatalystOps: Show Billing Dashboard**

---

## What you'll see

- **Total spend** for the selected period (7 days, 30 days, 90 days)
- **Spend by cluster** — identify your most expensive workloads
- **Spend by SKU** — interactive, jobs, serverless, SQL
- **Daily trend** — spot runaway jobs or idle clusters
- **Per-run cost** — shown after each dry run completes

---

## Requirements

Billing data is pulled from `system.billing.usage` via your SQL warehouse. You need:

1. **Unity Catalog** enabled on your workspace
2. **System Tables** enabled (Workspace Admin > Catalog > System)
3. A SQL warehouse (auto-selected, or configure `catalystops.billing.warehouseId`)

---

## Actual run cost (serverless)

Enable `catalystops.cost.queryBillingUsage` to fetch the real DBU cost for each dry run. A background job queries `system.billing.usage` ~2 minutes after the run completes and updates the estimate with the actual charge.

---

## Data freshness

Billing data typically appears 1–5 minutes after a run completes. Use the `$(refresh)` button in the Billing panel header to force a refresh.
