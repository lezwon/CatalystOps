# AI Integration via MCP

The MCP server starts automatically on port `49152`. In VS Code 1.99+ it's auto-discovered — no setup needed.

**Claude and other AI clients can:**
- Analyze code snippets (`analyze_pyspark`)
- Read active file issues (`get_active_file_issues`)
- Trigger dry runs (`run_dry_run`)
- Query billing data (`get_billing_summary`)
- Inspect job run plans (`get_last_job_run_analysis`)

For other MCP clients, add `http://127.0.0.1:49152/mcp` as the server URL.
