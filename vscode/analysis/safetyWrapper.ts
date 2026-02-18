/**
 * Safety Wrapper - Neutralizes PySpark actions by commenting out dangerous lines.
 *
 * Instead of regex-replacing expressions (which breaks on multi-line calls and
 * nested parentheses), this walks line-by-line:
 *   1. Detects lines that start a dangerous action (.write, .collect, .show, etc.)
 *   2. Comments out that line and any continuation lines (tracking paren depth)
 *
 * This is safe for multi-line calls like:
 *   df.write.mode("overwrite").saveAsTable(
 *       self._format("{prefix}table_name")
 *   )
 */

/** Patterns that indicate a line starts a dangerous PySpark action. */
const DANGEROUS_PATTERNS = [
    /\.write\b/,                      // .write.mode(...).save(...)
    /\.collect\s*\(/,                 // .collect()
    /\.count\s*\(/,                   // .count()
    /\.show\s*\(/,                    // .show(...)
    /\.toPandas\s*\(/,               // .toPandas()
    /\.to_pandas_on_spark\s*\(/,     // .to_pandas_on_spark()
    /\.toLocalIterator\s*\(/,        // .toLocalIterator()
    /\.foreach\s*\(/,                // .foreach(...)
    /\.foreachBatch\s*\(/,           // .foreachBatch(...)
    /\.foreachPartition\s*\(/,       // .foreachPartition(...)
    /(?<!\w)display\s*\(/,           // display(df)
];

/**
 * Count parenthesis balance in a line, ignoring parens inside strings.
 * Returns positive if more opens than closes, negative if more closes.
 */
function parenBalance(line: string): number {
    let balance = 0;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (const ch of line) {
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === "'" && !inDouble) {
            inSingle = !inSingle;
        } else if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (!inSingle && !inDouble) {
            if (ch === '(') { balance++; }
            else if (ch === ')') { balance--; }
        }
    }
    return balance;
}

/**
 * Check if a line contains a dangerous PySpark action.
 */
function isDangerousLine(line: string): boolean {
    const trimmed = line.trim();
    // Skip already-commented lines
    if (trimmed.startsWith('#')) { return false; }
    return DANGEROUS_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Neutralize dangerous PySpark actions in code.
 * Comments out lines with write/collect/show/etc. and their multi-line continuations.
 */
export function neutralizeCode(code: string): string {
    const lines = code.split('\n');
    const result: string[] = [];
    let commenting = false;
    let depth = 0;

    for (const line of lines) {
        if (!commenting) {
            if (isDangerousLine(line)) {
                commenting = true;
                depth = parenBalance(line);
                result.push(`# [CatalystOps: neutralized] ${line.trimStart()}`);
                if (depth <= 0) {
                    commenting = false;
                    depth = 0;
                }
            } else {
                result.push(line);
            }
        } else {
            // Continue commenting out continuation lines until parens balance
            depth += parenBalance(line);
            result.push(`# [CatalystOps: neutralized] ${line.trimStart()}`);
            if (depth <= 0) {
                commenting = false;
                depth = 0;
            }
        }
    }

    return result.join('\n');
}
