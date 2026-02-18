/**
 * Cluster Script Generator - Creates Python wrapper script for cluster execution.
 *
 * The generated script:
 * 1. Bundles only the .py files that are actually imported by the user code
 * 2. Inlines their content directly into global scope (functions accessible without module prefix)
 * 3. Strips the corresponding import statements from the user code
 * 4. Executes the neutralized user code
 * 5. Discovers all DataFrame variables in local scope
 * 6. Captures explain("formatted") plan for each DataFrame
 * 7. Collects cluster info from SparkContext
 * 8. Returns JSON between sentinel markers
 *
 * No external libraries needed — uses only PySpark builtins.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RESULT_START_MARKER, RESULT_END_MARKER } from '../models/constants';
import { neutralizeCode } from './safetyWrapper';

/**
 * Build a map of module name → file path for all .py files in a directory.
 */
function collectPyFileMap(dir: string): Map<string, string> {
    const map = new Map<string, string>();
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.py')) {
                const moduleName = entry.name.slice(0, -3); // strip .py
                map.set(moduleName, path.join(dir, entry.name));
            }
        }
    } catch {
        // skip unreadable dirs
    }
    return map;
}

/**
 * Parse import statements from Python code and return the set of local module
 * names that are actually available in the source directory.
 *
 * Handles:
 *   - from foo import bar
 *   - from foo import bar, baz
 *   - from foo import bar as b
 *   - import foo
 *   - import foo as f
 */
function parseImportedLocalModules(code: string, availableModules: Set<string>): Set<string> {
    const imported = new Set<string>();
    for (const line of code.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) { continue; }

        // from foo import ...
        const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s/);
        if (fromMatch) {
            const mod = fromMatch[1].split('.')[0];
            if (availableModules.has(mod)) { imported.add(mod); }
            continue;
        }

        // import foo [as bar], baz [as b], ...
        const importMatch = trimmed.match(/^import\s+(.+)/);
        if (importMatch) {
            for (const part of importMatch[1].split(',')) {
                const mod = part.trim().split(/\s+as\s+/)[0].trim().split('.')[0];
                if (availableModules.has(mod)) { imported.add(mod); }
            }
        }
    }
    return imported;
}

/**
 * Strip import lines for bundled modules from user code, replacing them with
 * a comment so the line numbers shift minimally.
 */
function stripImports(code: string, bundledModules: Set<string>): string {
    return code.split('\n').map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) { return line; }

        const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s/);
        if (fromMatch && bundledModules.has(fromMatch[1].split('.')[0])) {
            return `# [CatalystOps: bundled] ${trimmed}`;
        }

        const importMatch = trimmed.match(/^import\s+([\w.]+)/);
        if (importMatch && bundledModules.has(importMatch[1].split('.')[0])) {
            return `# [CatalystOps: bundled] ${trimmed}`;
        }

        return line;
    }).join('\n');
}

/**
 * Find the file path of the source file by matching its content.
 */
function findSourceFile(userCode: string, sourceDir: string): string {
    try {
        const entries = fs.readdirSync(sourceDir);
        for (const entry of entries) {
            if (!entry.endsWith('.py')) { continue; }
            const filePath = path.join(sourceDir, entry);
            try {
                if (fs.readFileSync(filePath, 'utf-8') === userCode) { return filePath; }
            } catch { /* skip */ }
        }
    } catch { /* skip */ }
    return path.join(sourceDir, '__catalystops_source__.py');
}

/**
 * Escape code for embedding inside Python triple single-quotes ('''...''').
 */
function escapeForTripleQuote(code: string): string {
    return code
        .replace(/\\/g, '\\\\')
        .replace(/'''/g, "\\'\\'\\'");
}

/**
 * Bundle only the local .py files that are actually imported by the user code.
 * Returns inline Python code (functions in global scope) and the set of bundled module names.
 */
function bundleImportedFiles(
    userCode: string,
    sourceFile: string,
    sourceDir: string,
): { bundledCode: string; bundledModules: Set<string>; bundledFileNames: string[] } {
    const pyFileMap = collectPyFileMap(sourceDir);

    // Exclude the source file itself
    const sourceBasename = path.basename(sourceFile, '.py');
    pyFileMap.delete(sourceBasename);

    const availableModules = new Set(pyFileMap.keys());
    const neededModules = parseImportedLocalModules(userCode, availableModules);

    const chunks: string[] = [];
    const bundledFileNames: string[] = [];

    for (const mod of neededModules) {
        const filePath = pyFileMap.get(mod);
        if (!filePath) { continue; }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const neutralized = neutralizeCode(content);
            // Inline directly — no module wrapper, functions land in global scope
            chunks.push(`# === ${path.basename(filePath)} ===\n${neutralized}`);
            bundledFileNames.push(path.basename(filePath));
        } catch {
            // Skip unreadable files
        }
    }

    return {
        bundledCode: chunks.join('\n\n'),
        bundledModules: neededModules,
        bundledFileNames,
    };
}

/**
 * Generate the full Python wrapper script to execute on the cluster.
 * Also returns the processed user code (for display purposes).
 */
export function generateClusterScript(
    userCode: string,
    sourceDir?: string,
): { script: string; processedUserCode: string } {
    let processedCode = userCode;
    let bundledDeps = '';
    let fileManifest = '# No local files bundled';

    if (sourceDir) {
        const sourceFile = findSourceFile(userCode, sourceDir);
        const { bundledCode, bundledModules, bundledFileNames } = bundleImportedFiles(
            userCode, sourceFile, sourceDir,
        );

        if (bundledFileNames.length > 0) {
            fileManifest = `# Bundled ${bundledFileNames.length} imported file(s):\n` +
                bundledFileNames.map(f => `#   - ${f}`).join('\n');
            bundledDeps = bundledCode + '\n\n';
        }

        // Strip import lines for bundled modules so functions are accessed directly
        processedCode = stripImports(userCode, bundledModules);
    }

    const neutralizedCode = neutralizeCode(processedCode);
    const fullCode = bundledDeps + neutralizedCode;
    const escapedCode = escapeForTripleQuote(fullCode);

    const script = `
# CatalystOps Dry Run Script - Auto-generated (no external deps)
${fileManifest}

import json
import traceback
from datetime import datetime

_catalystops_results = []
_catalystops_errors = []

def _catalystops_get_cluster_info():
    """Collect cluster info from SparkContext."""
    try:
        sc = spark.sparkContext
        conf = sc.getConf()
        _workers = int(conf.get("spark.executor.instances", "0"))
        _cores_per = int(conf.get("spark.executor.cores", "1"))
        return {
            "clusterName": conf.get("spark.databricks.clusterUsageTags.clusterName", ""),
            "workers": _workers,
            "coresPerWorker": _cores_per,
            "totalCores": max(_workers * _cores_per, 1),
            "executorMemory": conf.get("spark.executor.memory", ""),
            "driverMemory": conf.get("spark.driver.memory", ""),
            "sparkVersion": sc.version,
            "photonEnabled": conf.get("spark.databricks.photon.enabled", "false") == "true",
            "adaptiveQueryEnabled": conf.get("spark.sql.adaptive.enabled", "true") == "true",
            "instanceType": conf.get("spark.databricks.clusterUsageTags.clusterWorkerInstanceType", ""),
            "sparkConfigs": dict(conf.getAll()),
        }
    except Exception:
        return {
            "workers": 0, "coresPerWorker": 0, "totalCores": 0,
            "executorMemory": "", "driverMemory": "", "sparkVersion": "",
            "photonEnabled": False, "adaptiveQueryEnabled": False, "sparkConfigs": {},
        }

def _catalystops_get_plan(df):
    """Get explain(formatted) output as a string."""
    try:
        return df._jdf.queryExecution().executedPlan().toString()
    except Exception:
        try:
            import io, contextlib
            buf = io.StringIO()
            with contextlib.redirect_stdout(buf):
                df.explain(True)
            return buf.getvalue()
        except Exception:
            return ""

# Execute neutralized user code (with imported project files inlined above)
_catalystops_user_ns = {}
try:
    exec('''${escapedCode}''', globals(), _catalystops_user_ns)
except Exception as _e:
    _catalystops_errors.append({
        "phase": "execution",
        "error": str(_e),
        "traceback": traceback.format_exc(),
    })

# Discover DataFrame variables (even if exec partially failed)
from pyspark.sql import DataFrame
_catalystops_dfs = {}

for _name, _val in {**globals(), **_catalystops_user_ns}.items():
    if isinstance(_val, DataFrame) and not _name.startswith('_'):
        _catalystops_dfs[_name] = _val

# Collect cluster info once
_cluster_info = _catalystops_get_cluster_info()

# Analyze each DataFrame
for _df_name, _df in _catalystops_dfs.items():
    try:
        _plan = _catalystops_get_plan(_df)
        _catalystops_results.append({
            "analysisTime": datetime.now().isoformat(),
            "dataframeName": _df_name,
            "summary": {"critical": 0, "warnings": 0, "info": 0, "suggestions": 0},
            "cluster": _cluster_info,
            "executionPlan": {
                "physicalPlan": _plan,
                "logicalPlan": "",
                "operators": [],
                "totalStages": 0,
                "totalShuffles": 0,
                "joinCount": 0,
                "aggregationCount": 0,
            },
            "dataStats": {
                "partitionCount": _df.rdd.getNumPartitions() if _plan else 0,
                "columnCount": len(_df.columns),
                "hasNestedTypes": False,
                "nullPercentages": {},
                "partitionSizes": [],
            },
            "issues": [],
            "metadata": {},
        })
    except Exception as _e:
        _catalystops_errors.append({
            "dataframe": _df_name,
            "error": str(_e),
        })

# Check table statistics
_catalystops_table_stats = {}
try:
    for _tbl in spark.catalog.listTables():
        try:
            _db = _tbl.database or "default"
            _fqn = f"{_db}.{_tbl.name}"
            _desc = spark.sql(f"DESCRIBE EXTENDED {_fqn}")
            _stats_row = _desc.filter("col_name = 'Statistics'").collect()
            _has_stats = len(_stats_row) > 0 and 'bytes' in str(_stats_row[0])
            _catalystops_table_stats[_fqn] = _has_stats
        except:
            pass
except:
    pass

# Output results between sentinel markers
_output = json.dumps({
    "results": _catalystops_results,
    "errors": _catalystops_errors,
    "tableStats": _catalystops_table_stats,
})
print("${RESULT_START_MARKER}")
print(_output)
print("${RESULT_END_MARKER}")
`;

    return { script, processedUserCode: fullCode };
}

/**
 * Extract the JSON result from cluster command output.
 * Looks for content between sentinel markers.
 */
export function extractResult(output: string): { results: unknown[]; errors: unknown[] } | undefined {
    const startIdx = output.indexOf(RESULT_START_MARKER);
    const endIdx = output.indexOf(RESULT_END_MARKER);

    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
        return undefined;
    }

    const jsonStr = output
        .substring(startIdx + RESULT_START_MARKER.length, endIdx)
        .trim();

    try {
        return JSON.parse(jsonStr);
    } catch {
        return undefined;
    }
}
