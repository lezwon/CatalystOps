/**
 * Cluster Script Generator - Creates Python wrapper script for cluster execution.
 *
 * The generated script:
 * 1. Optionally installs spark_optimizer
 * 2. Executes the neutralized user code
 * 3. Discovers all DataFrame variables in local scope
 * 4. Runs SparkOptimizer.quick(df).to_dict() on each
 * 5. Returns JSON between sentinel markers
 */

import { RESULT_START_MARKER, RESULT_END_MARKER } from '../models/constants';
import { neutralizeCode } from './safetyWrapper';

/**
 * Generate the full Python wrapper script to execute on the cluster.
 */
export function generateClusterScript(
    userCode: string,
    installSparkOptimizer: boolean,
): string {
    const neutralizedCode = neutralizeCode(userCode);
    // Escape the code for embedding in a Python triple-quoted string
    const escapedCode = neutralizedCode
        .replace(/\\/g, '\\\\')
        .replace(/"""/g, '\\"\\"\\"');

    const installBlock = installSparkOptimizer
        ? `
# Install spark_optimizer if needed
try:
    import spark_optimizer
except ImportError:
    import subprocess, sys
    subprocess.check_call([sys.executable, "-m", "pip", "install", "spark-optimizer", "-q"])
    import spark_optimizer
`
        : `import spark_optimizer`;

    return `
# CatalystOps Dry Run Script - Auto-generated
import json
import traceback

${installBlock}

from spark_optimizer import SparkOptimizer

_catalystops_results = []
_catalystops_errors = []

try:
    # Execute neutralized user code
    _catalystops_user_ns = {}
    exec("""${escapedCode}""", globals(), _catalystops_user_ns)

    # Discover DataFrame variables
    from pyspark.sql import DataFrame
    _catalystops_dfs = {}

    # Check both local namespace from exec and global scope
    for _name, _val in {**globals(), **_catalystops_user_ns}.items():
        if isinstance(_val, DataFrame) and not _name.startswith('_'):
            _catalystops_dfs[_name] = _val

    # Analyze each DataFrame
    for _df_name, _df in _catalystops_dfs.items():
        try:
            _result = SparkOptimizer.quick(_df, name=_df_name)
            _catalystops_results.append(_result.to_dict())
        except Exception as _e:
            _catalystops_errors.append({
                "dataframe": _df_name,
                "error": str(_e)
            })

except Exception as _e:
    _catalystops_errors.append({
        "phase": "execution",
        "error": str(_e),
        "traceback": traceback.format_exc()
    })

# Output results between sentinel markers
_output = json.dumps({
    "results": _catalystops_results,
    "errors": _catalystops_errors
})
print("${RESULT_START_MARKER}")
print(_output)
print("${RESULT_END_MARKER}")
`;
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
