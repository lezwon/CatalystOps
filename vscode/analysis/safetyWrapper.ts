/**
 * Safety Wrapper - Replaces PySpark actions with explain("formatted") calls.
 *
 * Instead of commenting out dangerous actions, this extracts the DataFrame
 * expression from each action line and replaces the whole statement with a
 * single explain call so the query plan is captured without side effects.
 *
 * Single-line:
 *   df.write.mode("overwrite").saveAsTable("table")
 *   → df.explain("formatted")
 *
 *   result = df.filter("x > 0").collect()
 *   → result = df.filter("x > 0").explain("formatted")
 *
 *   display(df.groupBy("a").count())
 *   → df.groupBy("a").count().explain("formatted")
 *
 * Multi-line (paren-depth > 0 after the first line):
 *   The explain line is emitted for the first line; continuation lines are
 *   dropped (they are part of the replaced statement).
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
 * Ordered list of method-based dangerous patterns.
 * Each entry provides the regex to locate the method on the line so we can
 * slice off the DataFrame expression that precedes it.
 */
const METHOD_PATTERNS: RegExp[] = [
    /\.write\b/,
    /\.collect\s*\(/,
    /\.count\s*\(/,
    /\.show\s*\(/,
    /\.toPandas\s*\(/,
    /\.to_pandas_on_spark\s*\(/,
    /\.toLocalIterator\s*\(/,
    /\.foreach\s*\(/,
    /\.foreachBatch\s*\(/,
    /\.foreachPartition\s*\(/,
];

const DISPLAY_RE = /(?<!\w)display\s*\(/;

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
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; }
        else if (ch === '"' && !inSingle) { inDouble = !inDouble; }
        else if (!inSingle && !inDouble) {
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
    if (trimmed.startsWith('#')) { return false; }
    return DANGEROUS_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Extract the first argument from a function call, respecting nested parens.
 * `s` is the string starting right after the opening `(`.
 */
function extractFirstArg(s: string): string {
    let depth = 0;
    let i = 0;
    while (i < s.length) {
        const ch = s[i];
        if (ch === '(' || ch === '[' || ch === '{') { depth++; }
        else if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) { break; }
            depth--;
        } else if (ch === ',' && depth === 0) { break; }
        i++;
    }
    return s.substring(0, i).trim();
}

/**
 * Try to build an `expr.explain("formatted")` replacement for a dangerous line.
 *
 * Returns the replacement string (preserving leading indentation) or undefined
 * if the DataFrame expression cannot be determined from this line alone
 * (e.g. when the dangerous method is the very first token — a continuation).
 */
function tryReplaceWithExplain(line: string): string | undefined {
    const trimmed = line.trim();
    const indent = line.substring(0, line.length - line.trimStart().length);

    // display(df) → df.explain("formatted")
    const displayMatch = DISPLAY_RE.exec(trimmed);
    if (displayMatch !== null) {
        const afterOpen = trimmed.indexOf('(', displayMatch.index) + 1;
        const arg = extractFirstArg(trimmed.substring(afterOpen));
        if (arg) {
            return `${indent}${arg}.explain("formatted")`;
        }
    }

    // Method-based patterns: slice off the DF expression to the left of the method
    for (const re of METHOD_PATTERNS) {
        const m = re.exec(trimmed);
        if (m === null) { continue; }

        const dfExpr = trimmed.substring(0, m.index).trim();
        if (!dfExpr) {
            // Method starts the line — this is a continuation line (e.g. "    .write").
            // We can't build an explain from this line alone.
            return undefined;
        }
        return `${indent}${dfExpr}.explain("formatted")`;
    }

    return undefined;
}

/**
 * Replace dangerous PySpark actions with explain("formatted") calls.
 *
 * For each dangerous line:
 *   - If the DataFrame expression is on the same line → emit explain call.
 *   - Otherwise (continuation-only line, e.g. "    .write") → comment it out.
 * Multi-line continuation lines belonging to the replaced statement are dropped.
 */
export function neutralizeCode(code: string): string {
    const lines = code.split('\n');
    const result: string[] = [];
    let dropping = false;
    let depth = 0;

    for (const line of lines) {
        if (!dropping) {
            if (isDangerousLine(line)) {
                const replacement = tryReplaceWithExplain(line);
                if (replacement !== undefined) {
                    result.push(replacement);
                } else {
                    // Continuation-only dangerous line — fall back to comment
                    result.push(`# [CatalystOps: neutralized] ${line.trimStart()}`);
                }
                // Track paren depth to drop continuation lines
                depth = parenBalance(line);
                if (depth > 0) {
                    dropping = true;
                }
            } else {
                result.push(line);
            }
        } else {
            // Drop continuation lines — they are part of the replaced statement
            depth += parenBalance(line);
            if (depth <= 0) {
                dropping = false;
                depth = 0;
            }
            // Nothing pushed: continuation lines are consumed by the replacement
        }
    }

    return result.join('\n');
}
