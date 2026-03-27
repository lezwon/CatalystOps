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

Run **CatalystOps: Configure Databricks Connection** from the Command Palette (`⌘⇧P` / `Ctrl+Shift+P`) and follow the prompts, or add settings manually.

### Interactive Cluster

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi...",
  "catalystops.databricks.clusterId": "0123-456789-abcdef"
}
```

### Serverless

Leave `clusterId` blank and set execution mode to `serverless`:

```jsonc
{
  "catalystops.databricks.host": "https://myworkspace.cloud.databricks.com",
  "catalystops.databricks.token": "dapi...",
  "catalystops.databricks.executionMode": "serverless"
}
```

### SSH Tunnel

Route dry-run execution through an SSH tunnel to a cluster driver:

```jsonc
{
  "catalystops.connection.sshTunnel.enabled": true,
  "catalystops.connection.sshTunnel.connectionName": "my-cluster"
}
```

**Requirements:** Databricks CLI ≥ 0.269, VS Code Remote SSH extension, DBR 17+.

### Using `~/.databrickscfg`

CatalystOps reads your Databricks CLI config file automatically. Set the profile with:

```jsonc
{
  "catalystops.databricks.configPath": "~/.databrickscfg",
  "catalystops.databricks.profile": "DEFAULT"
}
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
