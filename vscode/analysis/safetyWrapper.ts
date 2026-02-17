/**
 * Safety Wrapper - Neutralizes PySpark actions via regex replacement
 * Replaces write/action operations with .explain("formatted") to get
 * Catalyst execution plans without executing the actual job.
 */

/**
 * Neutralize dangerous PySpark actions in code.
 * Replaces writes, collects, shows, etc. with explain() calls.
 */
export function neutralizeCode(code: string): string {
    let result = code;

    // Replace .write.mode(...).saveAsTable(...) and similar write chains
    // Match: .write followed by chained methods ending in save/saveAsTable/insertInto/parquet/csv/json/orc/text
    result = result.replace(
        /\.write\s*(?:\.\w+\s*\([^)]*\)\s*)*\.(?:save|saveAsTable|insertInto|parquet|csv|json|orc|text)\s*\([^)]*\)/g,
        '._catalystops_neutralized = True; print("__PLAN__:" + df.explain(True) if hasattr(df, "explain") else "")',
    );

    // Replace .write.mode(...).format(...).save(...)
    result = result.replace(
        /(\w+)\.write\b[^;\n]*/g,
        (match, varName) => {
            // Skip if already replaced
            if (match.includes('_catalystops_neutralized')) { return match; }
            return `print(${varName}._jdf.queryExecution().simpleString())`;
        },
    );

    // Replace .collect()
    result = result.replace(
        /(\w+)\.collect\s*\(\s*\)/g,
        '$1.explain("formatted")',
    );

    // Replace .count()
    result = result.replace(
        /(\w+)\.count\s*\(\s*\)/g,
        '$1.explain("formatted")',
    );

    // Replace .show(...)
    result = result.replace(
        /(\w+)\.show\s*\([^)]*\)/g,
        '$1.explain("formatted")',
    );

    // Replace .toPandas()
    result = result.replace(
        /(\w+)\.toPandas\s*\(\s*\)/g,
        '$1.explain("formatted")',
    );

    // Replace display(df)
    result = result.replace(
        /(?<!\w)display\s*\(\s*(\w+)\s*\)/g,
        'print($1.explain(True))',
    );

    // Replace .writeStream...start()
    result = result.replace(
        /\.writeStream\s*(?:\.\w+\s*\([^)]*\)\s*)*\.start\s*\([^)]*\)/g,
        '.explain("formatted")',
    );

    // Replace .foreach / .foreachBatch / .foreachPartition
    result = result.replace(
        /(\w+)\.(?:foreach|foreachBatch|foreachPartition)\s*\([^)]*\)/g,
        '$1.explain("formatted")',
    );

    // Replace .toLocalIterator()
    result = result.replace(
        /(\w+)\.toLocalIterator\s*\(\s*\)/g,
        '$1.explain("formatted")',
    );

    return result;
}
