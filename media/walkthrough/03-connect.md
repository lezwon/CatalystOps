# Connect to Databricks

To run a deep plan analysis, CatalystOps needs access to your Databricks workspace.

---

## What you need

**Cluster mode** (default)
- Databricks workspace URL — `https://myworkspace.azuredatabricks.net`
- Personal access token — generate in *User Settings > Developer > Access tokens*
- A running interactive cluster ID

**Serverless mode** (Premium tier)
- Workspace URL and token only — no cluster ID required
- Set `catalystops.databricks.executionMode` to `serverless`

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
