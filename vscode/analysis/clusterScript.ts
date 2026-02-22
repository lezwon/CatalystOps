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

/** Describes a local import that will be bundled. */
interface LocalImport {
    /** The local module name (e.g. "provider_utils") */
    module: string;
    /**
     * The prefix used in code to call into the module.
     * Set for `import foo` → "foo" and `import foo as alias` → "alias".
     * Undefined for `from foo import ...` (no prefix needed).
     */
    alias?: string;
}

/**
 * Parse import statements from Python code and return info about every local
 * module that should be bundled.
 *
 * Handles:
 *   - from foo import bar [as b]        → module bundled, no prefix
 *   - import foo                         → module bundled, prefix "foo"
 *   - import foo as alias                → module bundled, prefix "alias"
 *   - import foo, bar                    → both bundled with their names as prefix
 */
function parseImportedLocalModules(code: string, availableModules: Set<string>): LocalImport[] {
    const imports: LocalImport[] = [];
    const seen = new Set<string>();

    for (const line of code.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('#')) { continue; }

        // from foo import ...  (no prefix needed — names land in global scope)
        const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s/);
        if (fromMatch) {
            const mod = fromMatch[1].split('.')[0];
            if (availableModules.has(mod) && !seen.has(mod)) {
                imports.push({ module: mod });
                seen.add(mod);
            }
            continue;
        }

        // import foo [as alias], bar [as b], ...
        const importMatch = trimmed.match(/^import\s+(.+)/);
        if (importMatch) {
            for (const part of importMatch[1].split(',')) {
                const segments = part.trim().split(/\s+as\s+/);
                const mod = segments[0].trim().split('.')[0];
                const alias = segments[1]?.trim() || mod;
                if (availableModules.has(mod) && !seen.has(mod)) {
                    imports.push({ module: mod, alias });
                    seen.add(mod);
                }
            }
        }
    }
    return imports;
}

/**
 * Strip import lines for bundled modules and remove module-prefix references.
 *
 * For `import provider_utils as pu`:
 *   - The import line is commented out.
 *   - Every `pu.Foo(...)` occurrence becomes `Foo(...)` since the module's
 *     functions are now inlined into global scope.
 *
 * For `from provider_utils import Foo`:
 *   - The import line is commented out.
 *   - No prefix rewriting needed — `Foo` is already a direct name.
 */
function stripImportsAndRefs(code: string, localImports: LocalImport[]): string {
    const moduleSet = new Set(localImports.map(i => i.module));

    // Build alias → removal-regex pairs for `import X [as alias]` style only
    const aliasPrefixes: RegExp[] = [];
    for (const imp of localImports) {
        if (imp.alias) {
            // Match `alias.` at a word boundary so we don't clobber e.g. `mypu.foo`
            aliasPrefixes.push(new RegExp(`\\b${escapeRegex(imp.alias)}\\.`, 'g'));
        }
    }

    return code.split('\n').map(line => {
        const trimmed = line.trim();

        // Leave existing comment lines alone
        if (trimmed.startsWith('#')) { return line; }

        // Comment out import lines for bundled modules
        const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s/);
        if (fromMatch && moduleSet.has(fromMatch[1].split('.')[0])) {
            return `# [CatalystOps: bundled] ${trimmed}`;
        }

        const importMatch = trimmed.match(/^import\s+([\w.]+)/);
        if (importMatch && moduleSet.has(importMatch[1].split('.')[0])) {
            return `# [CatalystOps: bundled] ${trimmed}`;
        }

        // Remove alias. prefix from non-import lines (e.g. pu.GlobalProviders → GlobalProviders)
        let result = line;
        for (const pattern of aliasPrefixes) {
            result = result.replace(pattern, '');
        }
        return result;
    }).join('\n');
}

function escapeRegex(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * Returns inline Python code (functions in global scope) and import metadata.
 */
function bundleImportedFiles(
    userCode: string,
    sourceFile: string,
    sourceDir: string,
): { bundledCode: string; localImports: LocalImport[]; bundledFileNames: string[] } {
    const pyFileMap = collectPyFileMap(sourceDir);

    // Exclude the source file itself
    const sourceBasename = path.basename(sourceFile, '.py');
    pyFileMap.delete(sourceBasename);

    const availableModules = new Set(pyFileMap.keys());
    const localImports = parseImportedLocalModules(userCode, availableModules);

    const chunks: string[] = [];
    const bundledFileNames: string[] = [];

    for (const imp of localImports) {
        const filePath = pyFileMap.get(imp.module);
        if (!filePath) { continue; }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const neutralized = neutralizeCode(content);
            // Inline directly — functions land in global scope, no module wrapper
            chunks.push(`# === ${path.basename(filePath)} ===\n${neutralized}`);
            bundledFileNames.push(path.basename(filePath));
        } catch {
            // Skip unreadable files
        }
    }

    return {
        bundledCode: chunks.join('\n\n'),
        localImports,
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
        const { bundledCode, localImports, bundledFileNames } = bundleImportedFiles(
            userCode, sourceFile, sourceDir,
        );

        if (bundledFileNames.length > 0) {
            fileManifest = `# Bundled ${bundledFileNames.length} imported file(s):\n` +
                bundledFileNames.map(f => `#   - ${f}`).join('\n');
            bundledDeps = bundledCode + '\n\n';
        }

        // Strip import lines and rewrite alias.Foo() → Foo() for bundled modules
        processedCode = stripImportsAndRefs(userCode, localImports);
    }

    const neutralizedCode = neutralizeCode(processedCode);
    const fullCode = bundledDeps + neutralizedCode;
    const escapedCode = escapeForTripleQuote(fullCode);

    const script = `
# CatalystOps Dry Run Script - Auto-generated (no external deps)
${fileManifest}

import json
import time as _time
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
    """Get physical explain output as a string."""
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

def _catalystops_get_logical_plan(df):
    """Get analyzed logical plan as a string (shows original table references)."""
    try:
        return df._jdf.queryExecution().analyzed().toString()
    except Exception:
        return ""

# _catalystops_capture is injected into the exec namespace so that neutralized
# user code can call it directly instead of df.explain("formatted").
# This avoids monkey-patching DataFrame, which doesn't work reliably on
# Databricks Runtime because the runtime uses a subclass with its own explain.
import io as _catalystops_io
import contextlib as _catalystops_ctx
from pyspark.sql import DataFrame as _DataFrame
_catalystops_intercepted = []  # list of {'df': df, 'plan': plan_text}

def _catalystops_capture(df):
    """Called by neutralized writeStream/write/collect/etc. lines."""
    try:
        _buf = _catalystops_io.StringIO()
        with _catalystops_ctx.redirect_stdout(_buf):
            df.explain("formatted")
        _plan = _buf.getvalue()
        if not _plan.strip():
            _plan = _catalystops_get_plan(df)
    except Exception:
        try:
            _plan = _catalystops_get_plan(df)
        except Exception:
            _plan = ''
    _catalystops_intercepted.append({'df': df, 'plan': _plan})
    return None  # mimic writeStream.start() / collect() return value

# Execute neutralized user code (with imported project files inlined above)
# Use a single namespace seeded with globals() so that imports made inside
# exec (e.g. from pyspark.sql.types import StructType) are visible to
# functions defined in the same exec block — avoids NameError on exec-scoped
# imports when those names are referenced inside user-defined functions.
_catalystops_user_ns = dict(globals())
try:
    exec('''${escapedCode}''', _catalystops_user_ns)
except Exception as _e:
    _catalystops_errors.append({
        "phase": "execution",
        "error": str(_e),
        "traceback": traceback.format_exc(),
    })

# Build a lookup of pre-captured plan text keyed by DataFrame id.
# These plans were captured by redirecting stdout during .explain("formatted"),
# so they work for both static and streaming DataFrames.
_catalystops_plan_by_id = {id(e['df']): e['plan'] for e in _catalystops_intercepted}

# Discover DataFrames: namespace scan first, then anything captured via the
# explain hook (covers DataFrames created inside functions).
_catalystops_dfs = {}

for _name, _val in _catalystops_user_ns.items():
    if isinstance(_val, _DataFrame) and not _name.startswith('_'):
        _catalystops_dfs[_name] = _val

_catalystops_seen_ids = {id(_v) for _v in _catalystops_dfs.values()}
for _i, _entry in enumerate(_catalystops_intercepted):
    _captured_df = _entry['df']
    if id(_captured_df) not in _catalystops_seen_ids:
        # Try to match back to a variable name in the namespace
        _captured_name = next(
            (_n for _n, _v in _catalystops_user_ns.items()
             if _v is _captured_df and not _n.startswith('_')),
            f'dataframe_{_i + 1}',
        )
        _catalystops_dfs[_captured_name] = _captured_df
        _catalystops_seen_ids.add(id(_captured_df))

# Collect cluster info once
_cluster_info = _catalystops_get_cluster_info()

# Analyze each DataFrame
for _df_name, _df in _catalystops_dfs.items():
    try:
        _plan_start = _time.time()
        _pre_plan = _catalystops_plan_by_id.get(id(_df))
        if _pre_plan is not None:
            # Use the plan text captured during .explain("formatted") — works
            # for streaming DataFrames without re-triggering query execution.
            _plan = _pre_plan
            _logical = ''
            _plan_duration_ms = 0
        else:
            _plan = _catalystops_get_plan(_df)
            _logical = _catalystops_get_logical_plan(_df)
            _plan_duration_ms = int((_time.time() - _plan_start) * 1000)
        try:
            _col_count = len(_df.columns)
        except Exception:
            _col_count = 0
        try:
            _parallelism = _df.sparkSession.sparkContext.defaultParallelism
        except Exception:
            _parallelism = 0
        _catalystops_results.append({
            "analysisTime": datetime.now().isoformat(),
            "planDurationMs": _plan_duration_ms,
            "dataframeName": _df_name,
            "summary": {"critical": 0, "warnings": 0, "info": 0, "suggestions": 0},
            "cluster": _cluster_info,
            "executionPlan": {
                "physicalPlan": _plan,
                "logicalPlan": _logical,
                "operators": [],
                "totalStages": 0,
                "totalShuffles": 0,
                "joinCount": 0,
                "aggregationCount": 0,
            },
            "dataStats": {
                "partitionCount": _parallelism,
                "columnCount": _col_count,
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

# Diagnostic entry — always emitted, helps debug when results are empty
_catalystops_errors.append({
    "phase": "diagnostics",
    "intercepted_count": len(_catalystops_intercepted),
    "dfs_found": list(_catalystops_dfs.keys()),
    "capture_fn_available": '_catalystops_capture' in _catalystops_user_ns,
})

# Output results between sentinel markers
_output = json.dumps({
    "results": _catalystops_results,
    "errors": _catalystops_errors,
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
