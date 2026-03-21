# Connect to Databricks

To run a deep plan analysis, CatalystOps needs access to your Databricks workspace.

---

## Connection options

**Option A — Interactive cluster** (default)
- Databricks workspace URL — `https://myworkspace.azuredatabricks.net`
- Personal access token — generate in *User Settings > Developer > Access tokens*
- A running interactive cluster ID

**Option B — Serverless compute** (Premium tier)
- Workspace URL and token only — no cluster ID required
- Leave Cluster ID blank, or set `catalystops.databricks.executionMode` to `serverless`

**Option C — SSH tunnel** (DBR 17+)
- Requires [Databricks CLI ≥ 0.269](https://docs.databricks.com/aws/en/dev-tools/cli/install) and `databricks auth login`
- Set up once: `databricks ssh setup --name my-cluster --cluster <cluster-id>`
- Then enable in settings:
  ```
  catalystops.connection.sshTunnel.enabled: true
  catalystops.connection.sshTunnel.connectionName: "my-cluster"
  ```
- Scripts run directly on the cluster driver via SSH — no Jobs API required

---

## Using ~/.databrickscfg

If you already have the Databricks CLI configured, CatalystOps reads from `~/.databrickscfg` automatically:

```ini
[DEFAULT]
host  = https://myworkspace.azuredatabricks.net
token = dapiXXXXXXXXXXXXXXXX
```

---

## Run the configure command

Open the Command Palette (`⇧⌘P`) and run:

> **CatalystOps: Configure Databricks Connection**

This walks you through entering your host, token, execution mode, and cluster ID, then validates the connection.
