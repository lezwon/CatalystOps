# Clusters & SSH

The **Clusters** panel lists all interactive clusters in your Databricks workspace and lets you SSH into any of them with one click.

## Prerequisites

- [VS Code Remote SSH extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh)
- [Databricks CLI](https://docs.databricks.com/dev-tools/cli/install.html) ≥ 0.269
- DBR 17+ on the target cluster
- Databricks connection configured in CatalystOps

## Connecting via SSH

1. Open the CatalystOps sidebar — find the **Clusters** panel
2. Each cluster shows its name, current state (Running, Terminated, Pending, etc.), and Spark version
3. Click the **SSH** button next to any cluster

CatalystOps then:
- **If the cluster is stopped** — starts it automatically and polls state every 5 s with live progress
- Runs `databricks ssh setup` to configure the SSH tunnel keys
- Opens VS Code Remote SSH directly on the cluster driver

If anything needs fixing first (wrong access mode, Spark version too old), CatalystOps tells you what's wrong and offers to fix it with a single click — no manual cluster editing required.

## Auto-Fix for SSH Compatibility

When `databricks ssh setup` fails due to an incompatible cluster configuration, CatalystOps offers:

- **Set Single User mode** — switches the cluster access mode to Single User (required for SSH)
- **Upgrade Spark** — optionally upgrades to Spark 17.3 LTS if the current version is too old

Both fixes restart the cluster automatically and retry the SSH setup.

## Right-Click Actions

Right-click any cluster in the panel for additional options:

| Action | Description |
|--------|-------------|
| **Stop Cluster** | Terminates the cluster |
| **Reset SSH Host** | Clears the cached SSH alias — forces a fresh `databricks ssh setup` on next connect |

## SSH Tunnel for Dry Run

You can also route dry-run plan analysis through an SSH tunnel instead of the REST API. This is useful when your cluster is in a private network:

```jsonc
{
  "catalystops.connection.sshTunnel.enabled": true,
  "catalystops.connection.sshTunnel.connectionName": "my-cluster"
}
```

The `connectionName` must match the alias set up by `databricks ssh setup`.

## Idle Timeout

The SSH tunnel closes automatically after a configurable idle period:

```jsonc
{
  "catalystops.ssh.shutdownDelay": "30m"
}
```
