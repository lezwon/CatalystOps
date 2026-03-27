# Commands Reference

All commands are available from the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`). Search for **CatalystOps** to see the full list.

## Analysis

| Command | Shortcut | Description |
|---------|----------|-------------|
| **Analyze Cost (Dry Run)** | `⌘⇧K` / `Ctrl+Shift+K` | Run local + cluster/serverless/SSH analysis on the active file |
| **Analyze Selected Code** | — | Analyze only the highlighted selection |
| **Preview Dry Run Script** | — | Show the neutralized script that will be sent to Databricks |
| **Preview Full Dry Run Script** | — | Show the full wrapped script including import bundling |

## Databricks Setup

| Command | Description |
|---------|-------------|
| **Configure Databricks Connection** | Interactive setup wizard for workspace URL, token, and execution mode |

## Views & Reports

| Command | Description |
|---------|-------------|
| **Show Report** | Open a shareable HTML analysis report |
| **Show Plan DAG** | Open the interactive plan DAG webview |
| **Show Billing Dashboard** | Open the billing dashboard webview |
| **Refresh Billing Data** | Force a fresh billing query (bypasses 1-hour cache) |

## Jobs

| Command | Description |
|---------|-------------|
| **Refresh Jobs List** | Reload the Jobs sidebar |

## Clusters

| Command | Description |
|---------|-------------|
| **Refresh Clusters** | Reload the Clusters sidebar |
| **Connect via SSH** | One-click SSH into a cluster (also available via sidebar button) |
| **Stop Cluster** | Stop a running cluster |
| **Reset SSH Host** | Clear the cached SSH alias for a cluster and force re-setup |
