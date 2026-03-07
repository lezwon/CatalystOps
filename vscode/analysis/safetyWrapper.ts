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
 * Python keywords that may legally precede a method call on a DataFrame but
 * indicate the call is embedded in a control-flow or expression context rather
 * than being a standalone dangerous action.
 * e.g. "if orders.count() > 0:" or "for row in df.collect():"
 */
const KEYWORD_RE = /^(if|elif|while|for|return|assert|raise|yield|with|not|and|or|in|is|lambda)\b/;

/**
 * Scan `text` forward, tracking string context and bracket depth, and return
 * the position right after the last top-level separator (`,` or opening bracket)
 * at the final depth level. This identifies where the innermost complete
 * expression at the end of `text` begins.
 *
 * Example: findInnermostExprStart('print("x", df')
 *   → position right after the ',' → 'df' is the innermost expression
 */
function findInnermostExprStart(text: string): number {
    const lastSepAtDepth = new Map<number, number>();
    let depth = 0;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (escaped) { escaped = false; continue; }
        if (ch === '\\' && (inSingle || inDouble)) { escaped = true; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
        if (inSingle || inDouble) { continue; }

        if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
            lastSepAtDepth.set(depth, i + 1); // entering a new scope — record its open
        } else if (ch === ')' || ch === ']' || ch === '}') {
            lastSepAtDepth.delete(depth);
            depth--;
        } else if (ch === ',') {
            lastSepAtDepth.set(depth, i + 1); // comma at current depth
        }
    }

    return lastSepAtDepth.get(depth) ?? 0;
}

/**
 * Splice `_catalystops_capture(innerDf)` inline to replace only the dangerous
 * method call within an outer function call.
 *
 * Example:
 *   print("text", len(store), df.count())
 *   → print("text", len(store), _catalystops_capture(df))
 *
 * `methodStart` is the index of the dangerous method in `trimmed`.
 * `matchLen` is the length of the method match (which includes the opening '(').
 * Returns null if the innermost df expression cannot be identified.
 */
function spliceInlineCapture(
    trimmed: string,
    methodStart: number,
    matchLen: number,
    indent: string,
): string | null {
    const dfExprText = trimmed.substring(0, methodStart);
    const innerDfStart = findInnermostExprStart(dfExprText);
    const innerDf = dfExprText.substring(innerDfStart).trim();
    if (!innerDf) { return null; }

    // Find the end of the dangerous call by scanning forward for the matching ')'.
    // matchLen includes the opening '(' (verified by caller).
    let depth = 1;
    let pos = methodStart + matchLen;
    let inSingle = false;
    let inDouble = false;
    let escaped = false;
    while (pos < trimmed.length && depth > 0) {
        const ch = trimmed[pos];
        if (escaped) { escaped = false; pos++; continue; }
        if (ch === '\\' && (inSingle || inDouble)) { escaped = true; pos++; continue; }
        if (ch === '"' && !inSingle) { inDouble = !inDouble; pos++; continue; }
        if (ch === "'" && !inDouble) { inSingle = !inSingle; pos++; continue; }
        if (!inSingle && !inDouble) {
            if (ch === '(') { depth++; }
            else if (ch === ')') { depth--; }
        }
        pos++;
    }

    const prefix = dfExprText.substring(0, innerDfStart);
    const suffix = trimmed.substring(pos);

    return `${indent}${prefix}_catalystops_capture(${innerDf})${suffix}`;
}

/**
 * Detect if dfExpr is in a dict value position: `"key": actual_expr` or `key: actual_expr`.
 * Returns `{ prefix, actualExpr }` if matched, or null otherwise.
 *
 * Handles string keys ("a", 'a') and bareword/numeric keys (view, 0, etc.).
 * Does NOT match f-string interpolation braces or slice colons (those patterns
 * don't appear at the START of dfExpr because dfExpr is already stripped to the
 * portion to the left of the dangerous method).
 */
function detectDictValuePosition(dfExpr: string): { prefix: string; actualExpr: string } | null {
    const m = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\w+)\s*:\s*/.exec(dfExpr);
    if (!m) { return null; }
    const actualExpr = dfExpr.substring(m[0].length).trim();
    if (!actualExpr) { return null; }
    return { prefix: dfExpr.substring(0, m[0].length), actualExpr };
}

/**
 * Find the index of a simple assignment `=` in an expression string, skipping
 * compound operators (==, !=, <=, >=, :=, +=, -=, *=, /=, **=, //=, etc.).
 * Returns -1 if no assignment operator is found.
 */
function findAssignmentIndex(expr: string): number {
    for (let i = 0; i < expr.length; i++) {
        if (expr[i] !== '=') { continue; }
        const prev = i > 0 ? expr[i - 1] : '';
        const next = i < expr.length - 1 ? expr[i + 1] : '';
        if (next === '=') { continue; }              // ==
        if ('!<>:+-*/%|&^~='.includes(prev)) { continue; } // augmented / comparison / second = of ==
        return i;
    }
    return -1;
}

/**
 * Try to build a `_catalystops_capture(expr)` replacement for a dangerous line.
 *
 * Return values:
 *   string    — use this as the replacement line
 *   null      — dangerous call is embedded in an expression context (e.g.
 *               "if df.count() > 0:"); keep the line unchanged and do NOT
 *               start dropping continuation lines
 *   undefined — method is the very first token (a continuation line like
 *               "    .write"); comment the line out
 */
function tryReplaceWithExplain(line: string): string | null | undefined {
    const trimmed = line.trim();
    const indent = line.substring(0, line.length - line.trimStart().length);

    // Trailing comma: dict entries and function args end with ','; preserve it.
    const trailingComma = trimmed.endsWith(',') ? ',' : '';

    // display(df) → _catalystops_capture(df)
    const displayMatch = DISPLAY_RE.exec(trimmed);
    if (displayMatch !== null) {
        const afterOpen = trimmed.indexOf('(', displayMatch.index) + 1;
        const arg = extractFirstArg(trimmed.substring(afterOpen));
        if (arg) {
            return `${indent}_catalystops_capture(${arg})${trailingComma}`;
        }
    }

    // Method-based patterns: slice off the DF expression to the left of the method
    for (const re of METHOD_PATTERNS) {
        const m = re.exec(trimmed);
        if (m === null) { continue; }

        let dfExpr = trimmed.substring(0, m.index).trim();
        if (!dfExpr) {
            // Method starts the line — continuation (e.g. "    .write").
            return undefined;
        }
        // Strip outer f-string context if the dangerous call is inside an interpolation,
        // e.g. print(f"Total rows: {df_spark.count()}") → _catalystops_capture(df_spark)
        dfExpr = stripFStringPrefix(dfExpr);
        if (!dfExpr) {
            return undefined;
        }
        // If dfExpr has unmatched open parens the dangerous call is an argument
        // inside an outer function call (e.g. print(..., df.count())).
        // For method patterns that include '(' we can splice _catalystops_capture
        // inline so the outer call survives but the dangerous action is neutralized.
        if (parenBalance(dfExpr) > 0) {
            if (m[0][m[0].length - 1] === '(') {
                const spliced = spliceInlineCapture(trimmed, m.index, m[0].length, indent);
                if (spliced !== null) { return spliced; }
            }
            // Fallback (e.g. .write / .writeStream embedded in an outer call):
            // comment the line out so the dangerous action cannot execute.
            return undefined;
        }
        // If the extracted expression starts with a Python keyword the dangerous
        // call is embedded in a condition/loop (e.g. "if orders.count() > 0:").
        // Keep the line as-is rather than emitting invalid syntax.
        if (KEYWORD_RE.test(dfExpr)) {
            return null;
        }
        // If dfExpr contains an assignment (e.g. "all_rows = spark.read.parquet(...)")
        // preserve the LHS: all_rows = _catalystops_capture(spark.read.parquet(...))
        const assignIdx = findAssignmentIndex(dfExpr);
        if (assignIdx !== -1) {
            const lhs = dfExpr.substring(0, assignIdx).trimEnd();
            const rhs = dfExpr.substring(assignIdx + 1).trimStart();
            return `${indent}${lhs} = _catalystops_capture(${rhs})${trailingComma}`;
        }
        // If dfExpr is a dict value position ("key": expr or key: expr), wrap only
        // the value part so the replacement remains valid Python inside a dict literal.
        const dictPos = detectDictValuePosition(dfExpr);
        if (dictPos) {
            return `${indent}${dictPos.prefix}_catalystops_capture(${dictPos.actualExpr})${trailingComma}`;
        }
        return `${indent}_catalystops_capture(${dfExpr})${trailingComma}`;
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
/** Databricks notebook cell separator and header patterns to strip before processing. */
const NOTEBOOK_SEPARATOR_RE = /^#\s*COMMAND\s*-{5,}\s*$|^#\s*Databricks notebook source\s*$/;

/**
 * Cell-type magics whose body (lines after the magic line) is non-Python content.
 * These put the rest of the cell into a different language/runtime.
 * Single-line magics like %pip, %run, %fs are NOT listed here — they have no body.
 */
const CELL_BODY_MAGICS = new Set(['sh', 'bash', 'sql', 'scala', 'r', 'md']);

export function neutralizeCode(code: string): string {
    const lines = code.split('\n');
    const result: string[] = [];
    let dropping = false;    // depth mode: dangerous line opened parens
    let depth = 0;
    let droppingChain = false; // chain mode: drop .method() continuations
    let chainDepth = 0;        // paren depth within current chain segment
    let inMagicCell = false;   // true while inside a non-Python magic cell body

    for (const line of lines) {
        // Cell separator: reset magic-cell state so the next cell is processed fresh.
        if (NOTEBOOK_SEPARATOR_RE.test(line.trim())) {
            inMagicCell = false;
            continue;
        }

        const trimmed = line.trim();

        // Databricks notebook source format prefixes magic-command lines with
        // "# MAGIC " (a Python comment). When the script is uploaded via the
        // Workspace Import API with format=SOURCE/language=PYTHON, Databricks strips
        // the "# MAGIC " prefix from every matching line *before* Python parses the
        // file — even inside triple-quoted exec() strings — turning
        // "# MAGIC %sh" into bare "%sh" and crashing with SyntaxError.
        // Normalise these lines here so the raw magic is never sent to Databricks.
        const MAGIC_PREFIX_RE = /^#\s*MAGIC\s+/i;
        const isMagicPrefixed = MAGIC_PREFIX_RE.test(trimmed);
        const effective = isMagicPrefixed ? trimmed.replace(MAGIC_PREFIX_RE, '') : trimmed;

        // Inside a non-Python magic cell body: drop content lines.
        // A new % magic line (raw or # MAGIC-prefixed) starts a fresh cell context.
        if (inMagicCell) {
            if (!effective.startsWith('%')) { continue; }
            inMagicCell = false; // new magic — fall through to handle it
        }

        // Magic commands: %sh, %sql, %md, %pip, %run, %fs, %python, etc.
        // Covers raw `%sh` lines and Databricks-export `# MAGIC %sh` lines.
        if (effective.startsWith('%')) {
            const magicName = /^%(\w+)/.exec(effective)?.[1]?.toLowerCase() ?? '';
            if (magicName === 'python') {
                // %python just marks the cell as Python — skip the line, keep content.
                continue;
            }
            result.push(`# [CatalystOps: skipped] ${trimmed}`);
            // Cell-body magics with no inline args: drop following non-Python lines.
            const hasInlineArgs = effective.slice(magicName.length + 1).trim().length > 0;
            if (CELL_BODY_MAGICS.has(magicName) && !hasInlineArgs) {
                inMagicCell = true;
            }
            continue;
        }

        // Shell escapes: `!cmd` (raw) or `# MAGIC !cmd` (Databricks export).
        if (effective.startsWith('!')) {
            result.push(`# [CatalystOps: skipped] ${trimmed}`);
            continue;
        }

        // Remaining # MAGIC lines (non-% non-! body content already in inMagicCell,
        // or unreachable metadata) — skip rather than let Databricks strip the prefix.
        if (isMagicPrefixed) { continue; }

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
                // First non-continuation line — stop dropping.
                // Re-check for danger: e.g. the next dict entry may also be dangerous.
                droppingChain = false;
                chainDepth = 0;
                if (isDangerousLine(line)) {
                    const rep = tryReplaceWithExplain(line);
                    if (rep === null) {
                        result.push(line);
                    } else {
                        result.push(rep ?? `# [CatalystOps: neutralized] ${line.trimStart()}`);
                        if (bal > 0) {
                            depth = bal;
                            dropping = true;
                        } else {
                            droppingChain = true;
                            chainDepth = 0;
                        }
                    }
                } else {
                    result.push(line);
                }
            }
        } else {
            if (isDangerousLine(line)) {
                const replacement = tryReplaceWithExplain(line);
                if (replacement === null) {
                    // Dangerous call embedded in an expression context (e.g. "if df.count() > 0:").
                    // Keep the line unchanged and do NOT start dropping continuations.
                    result.push(line);
                } else {
                    result.push(replacement ?? `# [CatalystOps: neutralized] ${line.trimStart()}`);
                    if (bal > 0) {
                        depth = bal;
                        dropping = true;
                    } else {
                        droppingChain = true;
                        chainDepth = 0;
                    }
                }
            } else {
                result.push(line);
            }
        }
    }

    return result.join('\n');
}
