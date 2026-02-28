/**
 * Schema validator — static analysis for column-name and type errors in PySpark code.
 *
 * Catches mistyped column names and type mismatches before code runs on a cluster,
 * limited to schemas defined in the same file (StructType / DDL strings).
 *
 * Emits:
 *   SCHEMA_COL_001  — unknown column name (with "did you mean?" suggestions)
 *   SCHEMA_TYPE_001 — wrong column type for a function (e.g. F.sum on a STRING col)
 */

import { CodeIssue, Severity, IssueCategory } from '../models/types';
import {
    extractStructTypeSchemas,
    extractDdlSchemas,
    suggestColumns,
    findMatchingParen,
    ParsedSchema,
    SchemaField,
} from './schemaExtractor';
import { buildDfSchemaMap, schemaAtLine, BindingHistory } from './schemaTracker';
import { joinContinuationLines } from './schemaExtractor';
import functionTypesJson from './functionTypes.json';

// ── Type classification sets ──────────────────────────────────────────────────

const NUMERIC_TYPES  = new Set(['integer', 'long', 'double', 'float', 'decimal']);
const STRING_TYPES   = new Set(['string']);
const DATE_TYPES     = new Set(['date', 'timestamp']);
const ARRAY_TYPES    = new Set(['array']);

type FunctionCategory = 'numeric' | 'string' | 'date' | 'array';

/** Map from PySpark function name → required column type category, loaded from functionTypes.json. */
const FUNC_TYPES = new Map<string, FunctionCategory>(
    (Object.entries(functionTypesJson) as [string, string][])
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, v as FunctionCategory])
);

const NUMERIC_FUNCS = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'numeric').map(([k]) => k));
const STRING_FUNCS  = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'string').map(([k]) => k));
const DATE_FUNCS    = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'date').map(([k]) => k));
const ARRAY_FUNCS   = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'array').map(([k]) => k));

// ── Fast-exit guard ───────────────────────────────────────────────────────────

/** Return true only if the file contains content that might define a schema. */
function hasSchemaContent(code: string): boolean {
    return /StructType/.test(code)
        || /\b(INT|STRING|DOUBLE|FLOAT|BOOLEAN|TIMESTAMP|DATE)\b/.test(code);
}

// ── DataFrame-variable resolution ─────────────────────────────────────────────

/**
 * Given a line and current line index, find the first identifier that is
 * followed by '.' and has a known non-null schema in `history`.
 * This heuristic covers `df.select(...)`, `df2 = df.select(...)`, and
 * `df.groupBy("col").agg(F.sum("col"))`.
 */
function findDfSchemaForLine(
    line: string,
    lineIdx: number,
    history: BindingHistory,
): { dfVar: string; schema: ParsedSchema } | null {
    const idRe = /\b(\w+)\./g;
    let m: RegExpExecArray | null;
    while ((m = idRe.exec(line)) !== null) {
        const id = m[1];
        // Skip common non-DataFrame prefixes
        if (id === 'F' || id === 'functions' || id === 'spark' || id === 'sc'
            || id === 'sqlContext' || id === 'col' || id === 'lit') { continue; }
        const schema = schemaAtLine(history, id, lineIdx);
        if (schema !== null) { return { dfVar: id, schema }; }
    }
    return null;
}

// ── Issue factory ─────────────────────────────────────────────────────────────

function makeColumnIssue(
    colName: string,
    dfVar: string,
    schema: ParsedSchema,
    lineIdx: number,
    column: number,
): CodeIssue {
    const suggestions = suggestColumns(colName, schema);
    const didYouMean = suggestions.length > 0
        ? ` Did you mean: ${suggestions.map(s => `"${s}"`).join(', ')}?`
        : '';
    return {
        id: 'SCHEMA_COL_001',
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        title: `Unknown column "${colName}"`,
        description: `Column "${colName}" not found in schema of "${dfVar}".${didYouMean}`,
        fix: { description: 'Check the schema definition and correct the column name.' },
        line: lineIdx,
        column,
        endLine: lineIdx,
        endColumn: column + colName.length,
        location: `Line ${lineIdx + 1}`,
    };
}

const CATEGORY_TYPE_LIST: Record<string, string> = {
    numeric:        'integer, long, double, float, or decimal',
    string:         'string',
    'date/timestamp': 'date or timestamp',
    array:          'array',
};

const CATEGORY_CAST_TYPE: Record<string, string> = {
    numeric:          'LongType()',
    string:           'StringType()',
    'date/timestamp': 'TimestampType()',
    array:            'ArrayType(<element_type>)',
};

function makeTypeIssue(
    colName: string,
    funcName: string,
    actualType: string,
    expectedCategory: string,
    lineIdx: number,
    column: number,
): CodeIssue {
    const expectedTypes = CATEGORY_TYPE_LIST[expectedCategory] ?? expectedCategory;
    const castType = CATEGORY_CAST_TYPE[expectedCategory] ?? 'appropriate_type()';
    return {
        id: 'SCHEMA_TYPE_001',
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        title: `Type mismatch: "${funcName}" expects ${expectedCategory} but "${colName}" is ${actualType}`,
        description: `Function "${funcName}" requires a ${expectedCategory} column (${expectedTypes}), but "${colName}" is of type ${actualType}. If this column is produced by a UDF, declare its return type explicitly and cast the output.`,
        fix: {
            description: `Cast "${colName}" to a compatible type, or cast a UDF's return value at the call site.`,
            code: `# Option 1 — cast the column:
df = df.withColumn("${colName}", F.col("${colName}").cast(${castType}))

# Option 2 — cast inside withColumn if produced by a UDF:
df = df.withColumn("${colName}", my_udf(F.col("input")).cast(${castType}))

# Option 3 — declare the UDF return type to let Spark track it:
my_udf = udf(my_func, returnType=${castType})`,
        },
        line: lineIdx,
        column,
        endLine: lineIdx,
        endColumn: column + funcName.length,
        location: `Line ${lineIdx + 1}`,
    };
}

// ── Column extraction helpers ─────────────────────────────────────────────────

/**
 * Find the index of the matching ')' for the '(' that immediately precedes
 * `searchFrom` in `line`, using simple depth tracking (no string awareness
 * needed since we call this only on trimmed method-call substrings).
 */
function findCloseParenSimple(line: string, openIdx: number): number {
    let depth = 0;
    for (let i = openIdx; i < line.length; i++) {
        if (line[i] === '(') { depth++; }
        else if (line[i] === ')') {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return line.length - 1;
}

/**
 * Extract all bare string-literal column names from a comma-separated argument
 * list (the content between the outer parentheses of a method call).
 * Returns [] if the args contain `col(...)`, `F.col(...)`, or `*`.
 */
function extractStringColArgs(argsText: string): string[] {
    // If any arg is a function call expression, bail out — too complex to parse simply
    if (/\bcol\s*\(/.test(argsText) || /F\.\w+\s*\(/.test(argsText)) { return []; }
    const cols: string[] = [];
    const strRe = /["']([^"'\\]*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(argsText)) !== null) {
        if (m[1] !== '*') { cols.push(m[1]); }
    }
    return cols;
}

// ── Continuation-line helpers ─────────────────────────────────────────────────

/**
 * Build a mapping from original line index → joined line index.
 */
function buildOrigToJoined(lineMap: number[], rawLineCount: number): number[] {
    const origToJoined: number[] = new Array(rawLineCount).fill(0);
    for (let j = 0; j < lineMap.length; j++) {
        const start = lineMap[j];
        const end = j + 1 < lineMap.length ? lineMap[j + 1] : rawLineCount;
        for (let o = start; o < end; o++) { origToJoined[o] = j; }
    }
    return origToJoined;
}

/**
 * For a continuation line (starting with '.'), scan backward through rawLines
 * to find the DataFrame context — the variable and its schema immediately
 * before this continuation block began.
 */
function lookBackForDfContext(
    rawLines: string[],
    origIdx: number,
    origToJoined: number[],
    history: BindingHistory,
): { dfVar: string; schema: ParsedSchema } | null {
    for (let i = origIdx - 1; i >= Math.max(0, origIdx - 50); i--) {
        const prevLine = rawLines[i];
        const joinedIdx = origToJoined[i];

        // Try simple identifier-before-dot approach first
        const dfInfo = findDfSchemaForLine(prevLine, joinedIdx, history);
        if (dfInfo) { return dfInfo; }

        // Handle "var = [( ]sourceVar" patterns where sourceVar isn't followed by '.'
        // e.g.  "df = df \"  or  "df2 = df"  or  "df = (df"
        const rhsMatch = /^\s*(\w+)\s*=\s*\(?(\w+)/.exec(prevLine);
        if (rhsMatch) {
            const lhsVar = rhsMatch[1];
            const sourceVar = rhsMatch[2];
            if (!['F', 'functions', 'spark', 'sc', 'sqlContext', 'col', 'lit'].includes(sourceVar)) {
                // Use schema of sourceVar from BEFORE this joined line
                const sourceSchema = schemaAtLine(history, sourceVar, joinedIdx - 1);
                if (sourceSchema !== null) { return { dfVar: sourceVar, schema: sourceSchema }; }
                // Fallback: LHS variable schema at this joined line
                const lhsSchema = schemaAtLine(history, lhsVar, joinedIdx);
                if (lhsSchema !== null) { return { dfVar: lhsVar, schema: lhsSchema }; }
            }
        }

        // Handle bare identifier starting a chain: "df1_spark \" or just "df1_spark"
        // (no assignment, no dot — the identifier IS the DataFrame being chained on)
        const bareIdMatch = /^\s*(\w+)\s*\\?\s*$/.exec(prevLine.replace(/#.*$/, ''));
        if (bareIdMatch) {
            const candidate = bareIdMatch[1];
            if (!['F', 'functions', 'spark', 'sc', 'sqlContext', 'col', 'lit'].includes(candidate)) {
                const schema = schemaAtLine(history, candidate, joinedIdx);
                if (schema !== null) { return { dfVar: candidate, schema }; }
            }
        }

        // Stop looking if this previous line is not itself a continuation
        const trimmed = prevLine.trim();
        if (!trimmed.endsWith('\\') && !trimmed.startsWith('.')) { break; }
    }
    return null;
}

// ── Line-level checkers ───────────────────────────────────────────────────────

/**
 * Check all string column arguments in a method like .select(), .groupBy(), etc.
 */
function checkMethodColArgs(
    line: string,
    lineIdx: number,
    methodRe: RegExp,
    history: BindingHistory,
    issues: CodeIssue[],
    reportLine = lineIdx,
    dfContext: { dfVar: string; schema: ParsedSchema } | null = null,
): void {
    const dfInfo = dfContext ?? findDfSchemaForLine(line, lineIdx, history);
    if (!dfInfo) { return; }

    methodRe.lastIndex = 0;
    const m = methodRe.exec(line);
    if (!m) { return; }

    const openIdx = line.indexOf('(', m.index + m[0].length - 1);
    if (openIdx === -1) { return; }
    const closeIdx = findCloseParenSimple(line, openIdx);
    const argsText = line.substring(openIdx + 1, closeIdx);

    // Skip select("*")
    if (argsText.trim() === '"*"' || argsText.trim() === "'*'") { return; }

    const cols = extractStringColArgs(argsText);
    for (const col of cols) {
        if (!dfInfo.schema.some(f => f.name === col)) {
            const colStart = line.indexOf(`"${col}"`, openIdx);
            const colCol = colStart !== -1 ? colStart + 1 : openIdx + 1;
            if (columnsAddedBeforePos(line, colStart !== -1 ? colStart : openIdx).has(col)) { continue; }
            issues.push(makeColumnIssue(col, dfInfo.dfVar, dfInfo.schema, reportLine, colCol));
        }
    }
}

/**
 * Check only the first string argument of a method (e.g. .drop("col"),
 * .withColumnRenamed("old", "new")).
 */
function checkFirstStringColArg(
    line: string,
    lineIdx: number,
    methodRe: RegExp,
    history: BindingHistory,
    issues: CodeIssue[],
    reportLine = lineIdx,
    dfContext: { dfVar: string; schema: ParsedSchema } | null = null,
): void {
    const dfInfo = dfContext ?? findDfSchemaForLine(line, lineIdx, history);
    if (!dfInfo) { return; }

    methodRe.lastIndex = 0;
    const m = methodRe.exec(line);
    if (!m) { return; }

    const openIdx = line.indexOf('(', m.index + m[0].length - 1);
    if (openIdx === -1) { return; }
    const closeIdx = findCloseParenSimple(line, openIdx);
    const argsText = line.substring(openIdx + 1, closeIdx);

    const firstStr = /["']([^"'\\]*)["']/.exec(argsText);
    if (!firstStr || firstStr[1] === '*') { return; }
    const col = firstStr[1];
    if (!dfInfo.schema.some(f => f.name === col)) {
        const colStart = line.indexOf(`"${col}"`, openIdx);
        const colCol = colStart !== -1 ? colStart + 1 : openIdx + 1;
        issues.push(makeColumnIssue(col, dfInfo.dfVar, dfInfo.schema, reportLine, colCol));
    }
}

/**
 * Check `col("colname")` usage.
 */
function checkColFunction(
    line: string,
    lineIdx: number,
    history: BindingHistory,
    issues: CodeIssue[],
    reportLine = lineIdx,
    dfContext: { dfVar: string; schema: ParsedSchema } | null = null,
): void {
    const dfInfo = dfContext ?? findDfSchemaForLine(line, lineIdx, history);
    if (!dfInfo) { return; }

    // For join lines, unqualified F.col("x") may refer to columns in the right DataFrame.
    // Look up the right DF's schema so we don't flag columns that belong to it.
    let joinRightSchema: ParsedSchema | null = null;
    const joinM = /\.join\s*\(/.exec(line);
    if (joinM) {
        const openIdx = line.indexOf('(', joinM.index + joinM[0].length - 1);
        if (openIdx !== -1) {
            const closeIdx = findCloseParenSimple(line, openIdx);
            const firstArg = splitTopLevelArgs(line.substring(openIdx + 1, closeIdx))[0]?.trim() ?? '';
            const rightDfName = /^(\w+)$/.exec(firstArg)?.[1];
            if (rightDfName) { joinRightSchema = schemaAtLine(history, rightDfName, lineIdx); }
        }
    }

    const colFuncRe = /(?<!\w)col\s*\(\s*["']([^"'\\]*)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = colFuncRe.exec(line)) !== null) {
        const col = m[1];
        if (col === '*') { continue; }
        // Dotted names like "alias.column" are qualified references — skip, we can't resolve aliases
        if (col.includes('.')) { continue; }
        if (!dfInfo.schema.some(f => f.name === col)) {
            // Skip if the column was added by an earlier .withColumn in the same chain
            if (columnsAddedBeforePos(line, m.index).has(col)) { continue; }
            // Skip if the column exists in the right DataFrame of a join condition
            if (joinRightSchema?.some(f => f.name === col)) { continue; }
            issues.push(makeColumnIssue(col, dfInfo.dfVar, dfInfo.schema, reportLine, m.index));
        }
    }
}

/**
 * Check `df["colname"]` bracket access.
 */
function checkBracketAccess(
    line: string,
    lineIdx: number,
    history: BindingHistory,
    issues: CodeIssue[],
    reportLine = lineIdx,
): void {
    // Match: identifier["colname"] or identifier['colname']
    const bracketRe = /\b(\w+)\s*\[\s*["']([^"'\\]*)["']\s*\]/g;
    let m: RegExpExecArray | null;
    while ((m = bracketRe.exec(line)) !== null) {
        const varName = m[1];
        const col = m[2];
        // Dotted names are qualified references — skip
        if (col.includes('.')) { continue; }
        const schema = schemaAtLine(history, varName, lineIdx);
        if (!schema) { continue; }
        if (!schema.some(f => f.name === col)) {
            issues.push(makeColumnIssue(col, varName, schema, reportLine, m.index));
        }
    }
}

/**
 * Resolve a column name from either a bare string literal or a col() wrapper.
 * Returns the column name, or null if the argument form is not recognised.
 *
 *   "age"         → "age"
 *   col("age")    → "age"
 *   F.col("age")  → "age"  (unlikely in practice but handled)
 */
function resolveColArg(token: string): string | null {
    // Bare string literal: "age" or 'age'
    const bareStr = /^["']([^"'\\]*)["']$/.exec(token.trim());
    if (bareStr) { return bareStr[1]; }
    // col("age") or F.col("age")
    const colWrap = /(?:\w+\.)?col\s*\(\s*["']([^"'\\]*)["']\s*\)$/.exec(token.trim());
    if (colWrap) { return colWrap[1]; }
    return null;
}

/**
 * Check type-specific function calls.
 * Handles both bare string args and col()-wrapped args:
 *   F.sum("amount")          F.sum(col("amount"))
 *   F.upper("name")          F.upper(col("name"))
 *   F.concat("name", "age")  F.concat(col("name"), col("age"))
 */
function checkTypedFunctions(
    line: string,
    lineIdx: number,
    history: BindingHistory,
    issues: CodeIssue[],
    reportLine = lineIdx,
    dfContext: { dfVar: string; schema: ParsedSchema } | null = null,
): void {
    const dfInfo = dfContext ?? findDfSchemaForLine(line, lineIdx, history);
    if (!dfInfo) { return; }

    // Match: [F.]funcname( — then extract ALL column arguments (bare strings or col())
    // We scan for each function call and check every resolvable column arg.
    const funcStartRe = /(?:F\.|functions\.)?(\w+)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = funcStartRe.exec(line)) !== null) {
        const funcName = m[1];
        if (!FUNC_TYPES.has(funcName)) { continue; }

        // Extract content inside the parentheses of this function call
        const openIdx = m.index + m[0].length - 1; // position of '('
        const closeIdx = findCloseParenSimple(line, openIdx);
        const argsText = line.substring(openIdx + 1, closeIdx);

        // Split on top-level commas to get individual argument tokens
        const argTokens = splitTopLevelArgs(argsText);

        // Does this function call use col() wrappers for any arg?
        // If so, bare string args are likely literals (e.g. F.locate("e", col("name"))),
        // not column references. If not, bare strings ARE column references.
        const argsHaveColWrapper = /(?<!\w)col\s*\(/.test(argsText);

        for (const token of argTokens) {
            const isBareString = /^["']/.test(token.trim());
            const colName = resolveColArg(token);
            if (!colName) { continue; }

            const field = dfInfo.schema.find(f => f.name === colName);
            if (!field) {
                // col() wrappers: SCHEMA_COL_001 is already raised by checkColFunction.
                // Bare strings with no col() siblings: treat as column reference and flag.
                if (isBareString && !argsHaveColWrapper) {
                    issues.push(makeColumnIssue(colName, dfInfo.dfVar, dfInfo.schema, reportLine, m.index));
                }
                continue;
            }
            if (field.type === 'unknown') { continue; }

            if (NUMERIC_FUNCS.has(funcName) && !NUMERIC_TYPES.has(field.type)) {
                issues.push(makeTypeIssue(colName, funcName, field.type, 'numeric', reportLine, m.index));
            } else if (STRING_FUNCS.has(funcName) && !STRING_TYPES.has(field.type)) {
                issues.push(makeTypeIssue(colName, funcName, field.type, 'string', reportLine, m.index));
            } else if (DATE_FUNCS.has(funcName) && !DATE_TYPES.has(field.type)) {
                issues.push(makeTypeIssue(colName, funcName, field.type, 'date/timestamp', reportLine, m.index));
            } else if (ARRAY_FUNCS.has(funcName) && !ARRAY_TYPES.has(field.type)) {
                issues.push(makeTypeIssue(colName, funcName, field.type, 'array', reportLine, m.index));
            }
        }
    }
}

/**
 * Split a comma-separated argument list on top-level commas only
 * (ignoring commas inside nested parentheses).
 */
function splitTopLevelArgs(argsText: string): string[] {
    const tokens: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < argsText.length; i++) {
        const ch = argsText[i];
        if (ch === '(' || ch === '[') { depth++; }
        else if (ch === ')' || ch === ']') { depth--; }
        else if (ch === ',' && depth === 0) {
            tokens.push(argsText.substring(start, i).trim());
            start = i + 1;
        }
    }
    tokens.push(argsText.substring(start).trim());
    return tokens.filter(t => t.length > 0);
}

/**
 * Scan the full code for .join() calls — including multi-line paren-continuation ones —
 * and validate join conditions for column existence and type compatibility.
 *
 * Handles all equality condition forms:
 *   "col"                                  → string key (existence + type)
 *   ["col1", "col2"]                       → list keys (existence + type each)
 *   df1["x"] == df2["y"]                   → bracket equality (type)
 *   df1.x == df2.y                         → attribute access (type)
 *   F.col("x") == F.col("y")               → unqualified F.col() (type)
 *   F.col("a.x") == F.col("b.y")           → alias-qualified F.col() (type)
 */
function checkAllJoins(
    code: string,
    history: BindingHistory,
    issues: CodeIssue[],
): void {
    const NON_DF = new Set(['F', 'functions', 'spark', 'sc', 'sqlContext', 'col', 'lit']);
    const joinRe = /\.join\s*\(/g;
    let jm: RegExpExecArray | null;

    while ((jm = joinRe.exec(code)) !== null) {
        const openPos = jm.index + jm[0].length - 1;
        const closePos = findMatchingParen(code, openPos);
        if (closePos === -1) { continue; }

        // 0-based raw line where .join( appears
        const reportLine = code.substring(0, jm.index).split('\n').length - 1;
        if (/# noqa: catalystops\b/i.test(code.split('\n')[reportLine] ?? '')) { continue; }

        // Left DataFrame: identifier immediately before .join( (strip .alias("x") first)
        const beforeJoin = code.substring(0, jm.index).replace(/\.\s*alias\s*\(\s*["']\w+["']\s*\)\s*$/, '');
        const leftDfM = /\b(\w+)\s*$/.exec(beforeJoin);
        if (!leftDfM || NON_DF.has(leftDfM[1])) { continue; }
        const leftDfVar = leftDfM[1];
        const leftSchema = schemaAtLine(history, leftDfVar, reportLine);
        if (!leftSchema) { continue; }

        // Args (full text, may span multiple raw lines)
        const argsText = code.substring(openPos + 1, closePos);
        const topArgs = splitTopLevelArgs(argsText);
        if (topArgs.length < 2) { continue; }

        // Right DataFrame (first positional arg; may be df2 or df2.alias("b"))
        const rightDfRaw = topArgs[0].trim();
        const rightDfName = /^(\w+)$/.exec(rightDfRaw)?.[1]
            ?? /^(\w+)\s*\./.exec(rightDfRaw)?.[1];
        const rightSchema = rightDfName ? schemaAtLine(history, rightDfName, reportLine) : null;

        // Build alias map: scan the expression lines for .alias("x") calls
        const lineStart = code.lastIndexOf('\n', jm.index) + 1;
        const exprText = code.substring(lineStart, closePos + 1);
        const aliasMap = new Map<string, ParsedSchema>();
        const aliasRe = /\b(\w+)\.alias\s*\(\s*["'](\w+)["']\s*\)/g;
        let am: RegExpExecArray | null;
        while ((am = aliasRe.exec(exprText)) !== null) {
            if (NON_DF.has(am[1])) { continue; }
            const s = schemaAtLine(history, am[1], reportLine);
            if (s) { aliasMap.set(am[2], s); }
        }

        // Resolve join condition arg (on= keyword takes priority)
        let condArg: string | null = null;
        for (const arg of topArgs.slice(1)) {
            const kwm = /^on\s*=\s*([\s\S]+)$/.exec(arg.trim());
            if (kwm) { condArg = kwm[1].trim(); break; }
        }
        if (condArg === null) {
            const second = topArgs[1].trim();
            if (second && !/^\w+\s*=/.test(second)) { condArg = second; }
        }
        if (!condArg) { continue; }

        // ── Position helper ───────────────────────────────────────────────────
        // condArg was extracted via splitTopLevelArgs + trim(); find it in argsText
        // to anchor match positions back into the full code string.
        const condArgIdx = argsText.indexOf(condArg);
        const condArgStartInCode = openPos + 1 + (condArgIdx !== -1 ? condArgIdx : 0);

        /**
         * Given a match `m` on `condArg` and the column name length to highlight,
         * return the correct { line, col, endCol } for a VS Code diagnostic.
         * `matchOffset` is `m.index`; `highlightLen` is the text length to underline.
         */
        const pos = (matchOffset: number, highlightLen: number) => {
            const absStart = condArgStartInCode + matchOffset;
            const ln = code.substring(0, absStart).split('\n').length - 1;
            const lnStart = code.lastIndexOf('\n', absStart) + 1;
            const lnEnd = code.indexOf('\n', absStart);
            const lnLen = (lnEnd !== -1 ? lnEnd : code.length) - lnStart;
            const col = absStart - lnStart;
            return { line: ln, col, endCol: Math.min(col + highlightLen, lnLen) };
        };

        // ── Helper: resolve name (alias or direct DF var) → schema ───────────
        const resolve = (name: string): ParsedSchema | null =>
            aliasMap.get(name) ?? schemaAtLine(history, name, reportLine);

        // ── Helper: emit SCHEMA_JOIN_001 ──────────────────────────────────────
        const emitTypeMismatch = (
            lName: string, lCol: string, lType: string,
            rName: string, rCol: string, rType: string,
            matchOffset: number, matchLen: number,
        ) => {
            if (lType === rType) { return; }
            if (NUMERIC_TYPES.has(lType) && NUMERIC_TYPES.has(rType)) { return; }
            const p = pos(matchOffset, matchLen);
            issues.push({
                id: 'SCHEMA_JOIN_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: `Join condition type mismatch: "${lCol}" (${lType}) vs "${rCol}" (${rType})`,
                description: `Join condition compares "${lCol}" (${lType} in "${lName}") with "${rCol}" (${rType} in "${rName}"). Joining on incompatible types may fail or produce unexpected results.`,
                fix: { description: `Cast "${lCol}" or "${rCol}" to the same type before joining.` },
                line: p.line,
                column: p.col,
                endLine: p.line,
                endColumn: p.endCol,
                location: `Line ${p.line + 1}`,
            });
        };

        // ── String key: "colname" ─────────────────────────────────────────────
        const strKey = /^["']([^"'\\]*)["']$/.exec(condArg);
        if (strKey) {
            const colName = strKey[1];
            const p = pos(strKey.index + 1, colName.length);
            const lf = leftSchema.find(f => f.name === colName);
            const rf = rightSchema?.find(f => f.name === colName);
            if (!lf) { issues.push(makeColumnIssue(colName, leftDfVar, leftSchema, p.line, p.col)); }
            if (rightDfName && rightSchema && !rf) { issues.push(makeColumnIssue(colName, rightDfName, rightSchema, p.line, p.col)); }
            if (lf && rf && rightDfName && lf.type !== 'unknown' && rf.type !== 'unknown') {
                emitTypeMismatch(leftDfVar, colName, lf.type, rightDfName, colName, rf.type, strKey.index, strKey[0].length);
            }
            continue;
        }

        // ── List keys: ["col1", "col2"] ───────────────────────────────────────
        const listKey = /^\[([^\]]*)\]$/.exec(condArg);
        if (listKey) {
            const krRe = /["']([^"'\\]*)["']/g;
            let km: RegExpExecArray | null;
            while ((km = krRe.exec(listKey[1])) !== null) {
                const colName = km[1];
                // km.index is relative to listKey[1]; adjust to condArg offset
                const condOffset = listKey.index + 1 + km.index + 1; // +1 for '[', +1 past quote
                const p = pos(condOffset, colName.length);
                const lf = leftSchema.find(f => f.name === colName);
                const rf = rightSchema?.find(f => f.name === colName);
                if (!lf) { issues.push(makeColumnIssue(colName, leftDfVar, leftSchema, p.line, p.col)); }
                if (rightDfName && rightSchema && !rf) { issues.push(makeColumnIssue(colName, rightDfName, rightSchema, p.line, p.col)); }
                if (lf && rf && rightDfName && lf.type !== 'unknown' && rf.type !== 'unknown') {
                    emitTypeMismatch(leftDfVar, colName, lf.type, rightDfName, colName, rf.type, condOffset - 1, km[0].length);
                }
            }
            continue;
        }

        // ── Bracket equality: df["x"] == df2["y"] ────────────────────────────
        // Existence is already covered by checkBracketAccess; only check types here.
        const beRe = /\b(\w+)\s*\[\s*["']([^"'\\]*)["']\s*\]\s*==\s*(\w+)\s*\[\s*["']([^"'\\]*)["']\s*\]/g;
        let beM: RegExpExecArray | null;
        while ((beM = beRe.exec(condArg)) !== null) {
            const lS = resolve(beM[1]); const rS = resolve(beM[3]);
            const lf = lS?.find(f => f.name === beM![2]);
            const rf = rS?.find(f => f.name === beM![4]);
            if (lf && rf && lf.type !== 'unknown' && rf.type !== 'unknown') {
                emitTypeMismatch(beM[1], beM[2], lf.type, beM[3], beM[4], rf.type, beM.index, beM[0].length);
            }
        }
        if (/\w+\s*\[/.test(condArg)) { continue; }

        // ── Attribute access: df.col == df2.col ──────────────────────────────
        // checkBracketAccess/checkColFunction don't cover df.col syntax — check both
        // existence (SCHEMA_COL_001) and type compatibility (SCHEMA_JOIN_001) here.
        const aeRe = /\b(\w+)\.(\w+)(?!\s*\()\s*==\s*(\w+)\.(\w+)(?!\s*\()/g;
        let aeM: RegExpExecArray | null;
        while ((aeM = aeRe.exec(condArg)) !== null) {
            if (NON_DF.has(aeM[1])) { continue; }
            const lS = resolve(aeM[1]); const rS = resolve(aeM[3]);
            const lf = lS?.find(f => f.name === aeM![2]);
            const rf = rS?.find(f => f.name === aeM![4]);
            const p = pos(aeM.index, aeM[0].length);
            if (!lf && lS) { issues.push(makeColumnIssue(aeM[2], aeM[1], lS, p.line, p.col)); }
            if (!rf && rS) { issues.push(makeColumnIssue(aeM[4], aeM[3], rS, p.line, p.col)); }
            if (lf && rf && lf.type !== 'unknown' && rf.type !== 'unknown') {
                emitTypeMismatch(aeM[1], aeM[2], lf.type, aeM[3], aeM[4], rf.type, aeM.index, aeM[0].length);
            }
        }
        if (/\b\w+\.\w+(?!\s*\()\s*==/.test(condArg)) { continue; }

        // ── F.col() equality: F.col("x") == F.col("y") ───────────────────────
        // Also handles alias-qualified: F.col("a.x") == F.col("b.y")
        // Unqualified existence is covered by checkColFunction; only check types here.
        const fcRe = /(?:(?:F|functions)\.)?col\s*\(\s*["']([^"'\\]*)["']\s*\)\s*==\s*(?:(?:F|functions)\.)?col\s*\(\s*["']([^"'\\]*)["']\s*\)/g;
        let fcM: RegExpExecArray | null;
        while ((fcM = fcRe.exec(condArg)) !== null) {
            const resolveRef = (ref: string) => {
                const dot = ref.indexOf('.');
                if (dot !== -1) {
                    const alias = ref.substring(0, dot);
                    const col   = ref.substring(dot + 1);
                    return { name: alias, col, schema: aliasMap.get(alias) ?? null };
                }
                // Unqualified: attribute to whichever DF uniquely owns it
                const inLeft  = leftSchema.some(f => f.name === ref);
                const inRight = rightSchema?.some(f => f.name === ref) ?? false;
                if (inLeft  && !inRight) { return { name: leftDfVar,   col: ref, schema: leftSchema  }; }
                if (inRight && !inLeft && rightDfName) { return { name: rightDfName, col: ref, schema: rightSchema }; }
                return null;
            };
            const lRes = resolveRef(fcM[1]);
            const rRes = resolveRef(fcM[2]);
            if (!lRes?.schema || !rRes?.schema) { continue; }
            const lf = lRes.schema.find(f => f.name === lRes!.col);
            const rf = rRes.schema.find(f => f.name === rRes!.col);
            if (lf && rf && lf.type !== 'unknown' && rf.type !== 'unknown') {
                emitTypeMismatch(lRes.name, lRes.col, lf.type, rRes.name, rRes.col, rf.type, fcM.index, fcM[0].length);
            }
        }
    }
}

/**
 * Collect column names added by .withColumn("name", ...) calls that appear in
 * `line` strictly BEFORE position `beforeIdx`.
 * Used to avoid false-positive SCHEMA_COL_001 errors when a column is created
 * and then referenced later in the same chained expression.
 */
function columnsAddedBeforePos(line: string, beforeIdx: number): Set<string> {
    const added = new Set<string>();
    const wcRe = /\.withColumn\s*\(\s*["']([^"'\\]*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = wcRe.exec(line)) !== null) {
        if (m.index >= beforeIdx) { break; }
        added.add(m[1]);
    }
    return added;
}

// ── Set-operation column-order checker ────────────────────────────────────────

interface SetOpSpec {
    /** Regex that matches the method call opening paren. */
    pattern: RegExp;
    /** Code ID to emit when the schemas differ. */
    issueId: string;
    /** Human-readable method name used in error messages. */
    methodName: string;
    /** Suggested fix when schemas can differ (null = same-order-only, no allowMissingColumns). */
    missingColsFix: string | null;
}

/** Set operations that compare rows by column position, not name. */
const POSITIONAL_SET_OPS: SetOpSpec[] = [
    {
        pattern: /\.union(?!ByName)\s*\(/g,
        issueId: 'CODE_UNION_002',
        methodName: 'union()',
        missingColsFix: 'unionByName(allowMissingColumns=True)',
    },
    {
        pattern: /\.intersect(?:All)?\s*\(/g,
        issueId: 'CODE_INTERSECT_002',
        methodName: 'intersect()',
        missingColsFix: null,
    },
    {
        pattern: /\.(?:except(?:All)?|subtract)\s*\(/g,
        issueId: 'CODE_EXCEPT_002',
        methodName: 'except() / subtract()',
        missingColsFix: null,
    },
];

/**
 * Scan for positional set operations (.union, .intersect, .except, .subtract)
 * where both DataFrames have known schemas, and flag schema mismatches as CRITICAL.
 *
 * - Same column set but different order → CRITICAL (silent wrong results)
 * - Different column sets → CRITICAL (runtime error or wrong results)
 *
 * Falls back to the generic CODE_*_001 pattern in codeAnalyzer for cases
 * where schemas are not statically known.
 */
/**
 * Return true if `column` on `lineText` falls inside a Python comment.
 * Handles '#' inside string literals (they are NOT comment markers).
 */
function isInComment(lineText: string, column: number): boolean {
    let inStr: string | null = null;
    for (let i = 0; i < column; i++) {
        const ch = lineText[i];
        if (inStr) {
            if (ch === '\\') { i++; continue; }
            if (ch === inStr) { inStr = null; }
        } else if (ch === '"' || ch === "'") {
            inStr = ch;
        } else if (ch === '#') {
            return true;
        }
    }
    return false;
}

function checkAllPositionalSetOps(
    code: string,
    history: BindingHistory,
    issues: CodeIssue[],
): void {
    const NON_DF = new Set(['F', 'functions', 'spark', 'sc', 'sqlContext', 'col', 'lit']);
    const rawLines = code.split('\n');

    for (const spec of POSITIONAL_SET_OPS) {
        spec.pattern.lastIndex = 0;
        let m: RegExpExecArray | null;

        while ((m = spec.pattern.exec(code)) !== null) {
            const openPos = m.index + m[0].length - 1;
            const closePos = findMatchingParen(code, openPos);
            if (closePos === -1) { continue; }

            const reportLine = code.substring(0, m.index).split('\n').length - 1;
            const lineStart = code.lastIndexOf('\n', m.index) + 1;
            const col = m.index - lineStart;
            const lineText = rawLines[reportLine] ?? '';

            // Skip comment lines and noqa-suppressed lines
            if (isInComment(lineText, col)) { continue; }
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            // Left DataFrame: identifier immediately before the method call
            const before = code.substring(0, m.index).replace(/\.\s*alias\s*\(\s*["']\w+["']\s*\)\s*$/, '');
            const leftDfM = /\b(\w+)\s*$/.exec(before);
            if (!leftDfM || NON_DF.has(leftDfM[1])) { continue; }
            const leftDfVar = leftDfM[1];
            const leftSchema = schemaAtLine(history, leftDfVar, reportLine);
            if (!leftSchema) { continue; }

            // Right DataFrame: must be a bare variable name (not df_r.select(...) etc.)
            // If the user is passing an expression, they are already handling schema alignment.
            const argsText = code.substring(openPos + 1, closePos).trim();
            const rightDfName = /^(\w+)\s*$/.exec(argsText)?.[1];
            if (!rightDfName || NON_DF.has(rightDfName)) { continue; }
            const rightSchema = schemaAtLine(history, rightDfName, reportLine);
            if (!rightSchema) { continue; }

            const leftCols  = leftSchema.map(f => f.name);
            const rightCols = rightSchema.map(f => f.name);
            const leftSet   = new Set(leftCols);
            const rightSet  = new Set(rightCols);

            const sameColumnSet =
                leftCols.length === rightCols.length &&
                leftCols.every(c => rightSet.has(c)) &&
                rightCols.every(c => leftSet.has(c));

            if (!sameColumnSet) {
                // For intersect/except, column-set mismatches produce a runtime schema error
                // that is obvious (Spark will raise). Only flag the subtle silent bug:
                // same columns but in different order. Skip different-column-set cases.
                if (!spec.missingColsFix) { continue; }

                const leftOnly  = leftCols.filter(c => !rightSet.has(c));
                const rightOnly = rightCols.filter(c => !leftSet.has(c));
                const detail = [
                    leftOnly.length  ? `"${leftDfVar}" has extra: [${leftOnly.join(', ')}]`  : '',
                    rightOnly.length ? `"${rightDfName}" has extra: [${rightOnly.join(', ')}]` : '',
                ].filter(Boolean).join('; ');

                const fixCode = `result = ${leftDfVar}.${spec.missingColsFix.replace('(', `(${rightDfName}, `)}`;

                issues.push({
                    id: spec.issueId,
                    severity: Severity.CRITICAL,
                    category: IssueCategory.CODE,
                    title: `${spec.methodName} schema mismatch: "${leftDfVar}" and "${rightDfName}" have different columns`,
                    description: `${spec.methodName} requires identical schemas but the DataFrames have different column sets. ${detail}. Use ${spec.missingColsFix} to handle differing schemas.`,
                    fix: { description: `Align schemas before using ${spec.methodName}.`, code: fixCode },
                    line: reportLine,
                    column: col,
                    endLine: reportLine,
                    endColumn: col + m[0].length,
                    location: `Line ${reportLine + 1}`,
                });
                continue;
            }

            // Same column set — check whether the order differs
            const sameOrder = leftCols.every((c, i) => c === rightCols[i]);
            if (!sameOrder) {
                const fixCode = spec.missingColsFix
                    ? `result = ${leftDfVar}.unionByName(${rightDfName})`
                    : `# Align column order:\ncols = ${leftDfVar}.columns\nresult = ${leftDfVar}.${m[0].trimStart().slice(1, -1)}(${rightDfName}.select(cols))`;

                issues.push({
                    id: spec.issueId,
                    severity: Severity.CRITICAL,
                    category: IssueCategory.CODE,
                    title: `${spec.methodName} column order mismatch: "${leftDfVar}" vs "${rightDfName}"`,
                    description: `${spec.methodName} matches rows by position, not name.\n` +
                        `"${leftDfVar}": [${leftCols.join(', ')}]\n` +
                        `"${rightDfName}": [${rightCols.join(', ')}]\n` +
                        `Rows will be compared using the wrong columns silently.`,
                    fix: { description: `Align column order before calling ${spec.methodName}.`, code: fixCode },
                    line: reportLine,
                    column: col,
                    endLine: reportLine,
                    endColumn: col + m[0].length,
                    location: `Line ${reportLine + 1}`,
                });
            } else {
                // Same column set AND same order — schemas are compatible.
                // Emit a SUGGESTION to still prefer the name-based variant.
                // (Only applies to set operations that have a name-based alternative.)
                if (spec.missingColsFix) {
                    issues.push({
                        id: `${spec.issueId}_MATCH`,
                        severity: Severity.SUGGESTION,
                        category: IssueCategory.CODE,
                        title: `${spec.methodName} schemas match on "${leftDfVar}" and "${rightDfName}" — prefer unionByName`,
                        description: `Schemas are compatible (columns in the same order): [${leftCols.join(', ')}]. ` +
                            `${spec.methodName} is safe here, but unionByName() is more robust — it will stay correct if column order ever changes.`,
                        fix: {
                            description: `Replace .union(${rightDfName}) with .unionByName(${rightDfName})`,
                            code: `result = ${leftDfVar}.unionByName(${rightDfName})`,
                        },
                        line: reportLine,
                        column: col,
                        endLine: reportLine,
                        endColumn: col + m[0].length,
                        location: `Line ${reportLine + 1}`,
                    });
                }
            }
        }
    }
}

// ── Proactive schema alignment check ─────────────────────────────────────────

/**
 * Warn when two DataFrames in the same file have identical column NAME sets but
 * different column ORDER.  This is the silent bug behind most union/intersect
 * column-position mix-ups, and we can catch it at definition time — before any
 * set-op is even written.
 *
 * Issue id: SCHEMA_ALIGN_001  (WARNING)
 * Reported on: the LATER DataFrame's creation line.
 */
function checkSchemaColumnAlignment(
    history: BindingHistory,
    lineMap: number[],
    rawLines: string[],
    issues: CodeIssue[],
): void {
    // Collect the latest non-null schema snapshot for each variable.
    const snapshots: Array<{ name: string; columns: string[]; originalLine: number }> = [];
    for (const [varName, bindings] of history) {
        const latest = [...bindings].reverse().find(b => b.schema !== null && b.schema.length > 0);
        if (!latest) { continue; }
        const originalLine = lineMap[latest.definedAtLine] ?? latest.definedAtLine;
        snapshots.push({ name: varName, columns: latest.schema!.map(f => f.name), originalLine });
    }

    // Sort ascending by line so 'i' is always earlier than 'j'.
    snapshots.sort((a, b) => a.originalLine - b.originalLine);

    for (let i = 0; i < snapshots.length; i++) {
        for (let j = i + 1; j < snapshots.length; j++) {
            const a = snapshots[i];
            const b = snapshots[j];

            // Column-name sets must be identical …
            if (a.columns.length !== b.columns.length) { continue; }
            const setA = new Set(a.columns);
            if (!b.columns.every(c => setA.has(c))) { continue; }

            // … but the order must differ.
            if (a.columns.join(',') === b.columns.join(',')) { continue; }

            // Respect # noqa: catalystops on the later DataFrame's line.
            const lineText = rawLines[b.originalLine] ?? '';
            if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

            issues.push({
                id: 'SCHEMA_ALIGN_001',
                severity: Severity.WARNING,
                category: IssueCategory.CODE,
                title: `"${b.name}" has the same columns as "${a.name}" but in a different order`,
                description:
                    `"${a.name}": [${a.columns.join(', ')}]\n` +
                    `"${b.name}": [${b.columns.join(', ')}]\n` +
                    `Positional operations (union, intersect, except) will silently compare wrong columns.`,
                fix: {
                    description: `Reorder "${b.name}" to match "${a.name}"`,
                    code: `${b.name} = ${b.name}.select(${a.columns.map(c => `"${c}"`).join(', ')})`,
                },
                line: b.originalLine,
                column: 0,
                endLine: b.originalLine,
                endColumn: lineText.length,
                location: `Line ${b.originalLine + 1}`,
            });
        }
    }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Validate PySpark code for schema-related issues.
 * Returns an empty array when no schema can be found in the file.
 */
export function validateSchema(code: string): CodeIssue[] {
    if (!hasSchemaContent(code)) { return []; }

    const structSchemas = extractStructTypeSchemas(code);
    const ddlSchemas    = extractDdlSchemas(code);
    if (structSchemas.size === 0 && ddlSchemas.size === 0) { return []; }

    const history = buildDfSchemaMap(code, structSchemas, ddlSchemas);
    const issues: CodeIssue[] = [];
    const rawLines = code.split('\n');
    const { lineMap } = joinContinuationLines(rawLines);
    const origToJoined = buildOrigToJoined(lineMap, rawLines.length);

    for (let origIdx = 0; origIdx < rawLines.length; origIdx++) {
        const line = rawLines[origIdx];
        const joinedIdx = origToJoined[origIdx];

        // Skip comment lines and lines suppressed with # noqa: catalystops
        if (line.trim().startsWith('#')) { continue; }
        if (/# noqa: catalystops\b/i.test(line)) { continue; }

        // For continuation lines (starting with '.'), look backward for the DataFrame context
        // so each physical line gets its own correct squiggly position.
        let dfContext: { dfVar: string; schema: ParsedSchema } | null = null;
        if (line.trim().startsWith('.')) {
            dfContext = lookBackForDfContext(rawLines, origIdx, origToJoined, history);
        }

        // ── Column name checks ────────────────────────────────────────────────

        checkMethodColArgs(line, joinedIdx, /\.select\s*\(/, history, issues, origIdx, dfContext);
        checkMethodColArgs(line, joinedIdx, /\.groupBy\s*\(/, history, issues, origIdx, dfContext);
        checkMethodColArgs(line, joinedIdx, /\.(?:orderBy|sort)\s*\(/, history, issues, origIdx, dfContext);
        checkMethodColArgs(line, joinedIdx, /\.partitionBy\s*\(/, history, issues, origIdx, dfContext);
        checkFirstStringColArg(line, joinedIdx, /\.drop\s*\(/, history, issues, origIdx, dfContext);
        checkFirstStringColArg(line, joinedIdx, /\.withColumnRenamed\s*\(/, history, issues, origIdx, dfContext);
        checkColFunction(line, joinedIdx, history, issues, origIdx, dfContext);
        checkBracketAccess(line, joinedIdx, history, issues, origIdx);
        checkTypedFunctions(line, joinedIdx, history, issues, origIdx, dfContext);
    }

    // Full-code join pass: handles all equality forms and multi-line paren-continuation joins
    checkAllJoins(code, history, issues);

    // Full-code positional set-op pass: detects column-order mismatches in
    // union(), intersect(), except(), subtract(), and their *All variants
    checkAllPositionalSetOps(code, history, issues);

    // Proactive pass: warn when any two DataFrames share column names but differ
    // in column order, even before a set-op is written
    checkSchemaColumnAlignment(history, lineMap, rawLines, issues);

    return issues;
}
