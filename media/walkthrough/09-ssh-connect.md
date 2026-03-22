# One-Click SSH into Databricks Clusters

The **Clusters** sidebar lets you SSH into any Databricks cluster directly from VS Code — no CLI commands needed.

---

## The Clusters panel

Open the CatalystOps sidebar and look for the **Clusters** section. It lists all interactive clusters in your workspace with their current state (Running, Terminated, Pending).

Click the **↺** refresh button to reload the list.

---

## Connect via SSH

Click the SSH icon (📡) on any cluster to start the one-click flow:

1. **Auto-start** — if the cluster is stopped, CatalystOps starts it automatically and waits for it to reach Running state (polls every 5 s, up to 10 minutes)
2. **SSH setup** — runs `databricks ssh setup` to configure the connection in `~/.databricks/ssh-tunnel-configs/`
3. **Access mode fix** — if the cluster needs Single User mode for SSH, CatalystOps offers to apply the fix, optionally upgrade to Spark 17.3 LTS, and restart automatically
4. **Secret scope** — pre-creates the SSH tunnel key scope on Standard-tier workspaces
5. **Remote SSH** — opens a VS Code Remote SSH window for the cluster

---

## Requirements

- [Databricks CLI ≥ 0.269](https://docs.databricks.com/aws/en/dev-tools/cli/install) installed
- VS Code [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension
- Databricks Runtime 17+ with Unity Catalog enabled
- `databricks auth login` completed at least once

---

## Additional actions

Right-click any cluster for:

| Action | When to use |
|--------|-------------|
| **Stop Cluster** | Terminate a running cluster from VS Code (saves cost) |
| **Reset SSH Host** | Clear the cached alias to force a fresh `databricks ssh setup` on next connect |

> **Tip**: `catalystops.ssh.shutdownDelay` controls how long the cluster stays alive after your SSH session closes (default: `30m`). Set it to `1h` or more for longer coding sessions.

---

## Troubleshooting

- **"SSH is not available in this workspace plan"** — SSH requires a workspace with SSH enabled; contact your Databricks account team.
- **Setup failed after fix** — try "Reset SSH Host" and reconnect; the new setup uses the cluster's updated access mode.
- **Connection times out** — VS Code's SSH timeout is automatically raised to 180 s (Databricks clusters need time to start the SSH server).
