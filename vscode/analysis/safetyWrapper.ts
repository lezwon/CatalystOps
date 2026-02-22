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
    /\.writeStream\b/,                // .writeStream.format(...).start()
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
    /\.awaitTermination\s*\(/,       // query.awaitTermination() — StreamingQuery, not DataFrame
    /(?<!\w)display\s*\(/,           // display(df)
];

/**
 * Ordered list of method-based dangerous patterns.
 * Each entry provides the regex to locate the method on the line so we can
 * slice off the DataFrame expression that precedes it.
 */
const METHOD_PATTERNS: RegExp[] = [
    /\.writeStream\b/,
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
 * If `expr` ends with an unclosed f-string interpolation (e.g. `print(f"text: {df`),
 * return only the part after the last unmatched `{`. Otherwise return `expr` unchanged.
 *
 * This handles cases like `print(f"Total rows: {df_spark.count()}")` where the
 * dangerous method call is embedded inside an f-string expression.
 */
function stripFStringPrefix(expr: string): string {
    let braceDepth = 0;
    let lastOpenBrace = -1;
    for (let i = 0; i < expr.length; i++) {
        if (expr[i] === '{') { braceDepth++; lastOpenBrace = i; }
        else if (expr[i] === '}') { braceDepth--; }
    }
    if (braceDepth > 0 && lastOpenBrace !== -1) {
        return expr.substring(lastOpenBrace + 1).trim();
    }
    return expr;
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

    // display(df) → _catalystops_capture(df)
    const displayMatch = DISPLAY_RE.exec(trimmed);
    if (displayMatch !== null) {
        const afterOpen = trimmed.indexOf('(', displayMatch.index) + 1;
        const arg = extractFirstArg(trimmed.substring(afterOpen));
        if (arg) {
            return `${indent}_catalystops_capture(${arg})`;
        }
    }

    // Method-based patterns: slice off the DF expression to the left of the method
    for (const re of METHOD_PATTERNS) {
        const m = re.exec(trimmed);
        if (m === null) { continue; }

        let dfExpr = trimmed.substring(0, m.index).trim();
        if (!dfExpr) {
            // Method starts the line — this is a continuation line (e.g. "    .write").
            // We can't build a capture call from this line alone.
            return undefined;
        }
        // Strip outer f-string context if the dangerous call is inside an interpolation,
        // e.g. print(f"Total rows: {df_spark.count()}") → _catalystops_capture(df_spark)
        dfExpr = stripFStringPrefix(dfExpr);
        if (!dfExpr) {
            return undefined;
        }
        return `${indent}_catalystops_capture(${dfExpr})`;
    }

    return undefined;
}

/**
 * Replace dangerous PySpark actions with explain("formatted") calls.
 *
 * After emitting a replacement, continuation lines are dropped in one of
 * two modes:
 *
 * Depth mode — the dangerous line itself opened unbalanced parens
 *   (e.g. `.option(\n  "k","v"\n).save()`). Drop lines until the local
 *   paren depth returns to ≤ 0.
 *
 * Chain mode — the dangerous line had balanced parens (e.g. `df.writeStream`,
 *   `df.count()`). Drop every following line that either (a) starts with `.`
 *   or (b) is inside a multi-line argument of a chained call (chainDepth > 0).
 *   Stop at the first line that is neither — that line is kept.
 *
 * Crucially, globalDepth is NOT tracked. Tracking it across all lines
 * (including comment lines that may contain unmatched parens) causes false
 * positives that silently delete large blocks of code.
 *
 * Chain mode naturally handles the outer-paren wrapper pattern:
 *   query = (          ← kept (not dangerous)
 *       df.writeStream ← replaced; chain dropping starts
 *       .foreachBatch( ← starts with '.', dropped; chainDepth → 1
 *           lambda ... ← chainDepth > 0, dropped
 *       )              ← chainDepth > 0, dropped; chainDepth → 0
 *       .start()       ← starts with '.', dropped
 *   )                  ← no '.', chainDepth=0 → stop, kept ✓
 */
export function neutralizeCode(code: string): string {
    const lines = code.split('\n');
    const result: string[] = [];
    let dropping = false;    // depth mode: dangerous line opened parens
    let depth = 0;
    let droppingChain = false; // chain mode: drop .method() continuations
    let chainDepth = 0;        // paren depth within current chain segment

    for (const line of lines) {
        const bal = parenBalance(line);

        if (dropping) {
            depth += bal;
            if (depth <= 0) {
                dropping = false;
                depth = 0;
            }
            // line consumed — not pushed
        } else if (droppingChain) {
            const trimmed = line.trim();
            if (chainDepth > 0 || trimmed.startsWith('.')) {
                chainDepth += bal;
                // line consumed — not pushed
            } else {
                // First non-continuation line — stop dropping and keep it
                droppingChain = false;
                chainDepth = 0;
                result.push(line);
            }
        } else {
            if (isDangerousLine(line)) {
                const replacement = tryReplaceWithExplain(line);
                result.push(replacement ?? `# [CatalystOps: neutralized] ${line.trimStart()}`);
                if (bal > 0) {
                    depth = bal;
                    dropping = true;
                } else {
                    droppingChain = true;
                    chainDepth = 0;
                }
            } else {
                result.push(line);
            }
        }
    }

    return result.join('\n');
}
