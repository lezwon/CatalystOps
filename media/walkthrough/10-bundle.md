# Databricks Asset Bundle Support

If your workspace contains a `databricks.yml`, CatalystOps automatically detects it.

## Bundle Tasks Panel

Open the **Bundle Tasks** panel in the CatalystOps sidebar to see every `spark_python_task` and `notebook_task` defined across `databricks.yml` and all included resource files. Click any task to open its source file.

## YAML Linting

CatalystOps validates your bundle YAML inline as you edit:
- Invalid keys, wrong enum values, and missing required fields are underlined immediately
- Alert v2 API mistakes (`condition` → `evaluation`, wrong subscription nesting)
- Permission level mismatches per resource type
- File path existence checks for `python_file` and `notebook_path`

## Connect via Bundle Target

Run **CatalystOps: Configure Databricks Connection** — if a `databricks.yml` is present, the wizard shows a **Use Bundle Target** option that pre-fills your workspace host from the YAML.
