# Installation & Setup

## Install the Extension

Search for **CatalystOps** in the VS Code Extensions panel, or install from the terminal:

```
ext install CatalystOps.catalystops
```

Local analysis starts immediately — no configuration needed. Open any `.py` file and anti-pattern checks run automatically.

---

## Connect to Databricks (Optional)

Databricks connectivity is required for dry-run plan analysis, job run analysis, the clusters panel, and the billing dashboard. Local analysis always works without it.

Run **CatalystOps: Configure Databricks Connection** from the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`). The wizard detects what is available on your machine and shows only those options:

| Method | Requirement |
|--------|------------|
| **Azure CLI** | `az login` — workspaces auto-discovered from your Azure subscription |
| **GCP ADC** | `gcloud auth application-default login` |
| **~/.databrickscfg** | Databricks CLI already configured |
| **OAuth / Browser Login** | Any workspace — opens browser, no token needed |
| **Personal Access Token** | Workspace URL + token entered manually |

Cluster ID is only prompted when running a dry-run — not during connection setup.

### Manual Configuration

You can also set values directly in `settings.json`:

```jsonc
// Interactive cluster (cluster ID set at dry-run time)
{ "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi..." }

// Serverless
{ "catalystops.databricks.executionMode": "serverless" }

// SSH tunnel
{ "catalystops.connection.sshTunnel.enabled": true,
  "catalystops.connection.sshTunnel.connectionName": "my-cluster" }
```

---

## First Analysis

1. Open a `.py` file containing PySpark code — local checks run immediately
2. Press `⌘⇧K` (`Ctrl+Shift+K`) to run a full dry-run plan analysis against your Databricks cluster
3. Review issues in the **Issues** panel and the interactive **Explain Plan** tree

To suppress a specific line, add a comment:

```python
df.collect()  # noqa: catalystops
```
