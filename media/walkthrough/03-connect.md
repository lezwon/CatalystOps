# Connect to Databricks

Run **CatalystOps: Configure Databricks Connection** from the Command Palette.

The wizard auto-detects what's available and shows only those options:

| Method | Requirement |
|--------|------------|
| Azure CLI | `az login` done |
| GCP ADC | `gcloud auth application-default login` done |
| ~/.databrickscfg | Databricks CLI configured |
| OAuth / Browser Login | Any workspace — no token needed |
| Personal Access Token | Workspace URL + token |
