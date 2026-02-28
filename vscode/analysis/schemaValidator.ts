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

type FunctionCategory = 'numeric' | 'string' | 'date';

/** Map from PySpark function name → required column type category, loaded from functionTypes.json. */
const FUNC_TYPES = new Map<string, FunctionCategory>(
    (Object.entries(functionTypesJson) as [string, string][])
        .filter(([k]) => !k.startsWith('_'))
        .map(([k, v]) => [k, v as FunctionCategory])
);

const NUMERIC_FUNCS = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'numeric').map(([k]) => k));
const STRING_FUNCS  = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'string').map(([k]) => k));
const DATE_FUNCS    = new Set([...FUNC_TYPES.entries()].filter(([, v]) => v === 'date').map(([k]) => k));

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
    return {
        id: 'SCHEMA_TYPE_001',
        severity: Severity.WARNING,
        category: IssueCategory.CODE,
        title: `Type mismatch: "${funcName}" expects ${expectedCategory} but "${colName}" is ${actualType}`,
        description: `Function "${funcName}" requires a ${expectedCategory} column (${expectedTypes}), but "${colName}" is of type ${actualType}.`,
        fix: { description: `Cast "${colName}" to a compatible type (${expectedTypes}), or use an appropriate conversion function.` },
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
            const colCol = colStart !== -1 ? colStart + 1 : openIdx + 1; // inside the quotes
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

    const colFuncRe = /(?<!\w)col\s*\(\s*["']([^"'\\]*)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = colFuncRe.exec(line)) !== null) {
        const col = m[1];
        if (col === '*') { continue; }
        if (!dfInfo.schema.some(f => f.name === col)) {
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

    return issues;
}
