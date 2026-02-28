/**
 * Schema extraction utilities for PySpark static analysis.
 * Parses StructType definitions and DDL strings from Python source code
 * to enable compile-time column-name and type checks.
 */

export type FieldType =
    | 'string' | 'integer' | 'long' | 'double' | 'float'
    | 'boolean' | 'date' | 'timestamp' | 'binary'
    | 'decimal' | 'array' | 'map' | 'struct' | 'unknown';

export interface SchemaField { name: string; type: FieldType; }
export type ParsedSchema = SchemaField[];

/** One definition of a schema variable, tied to the source line it appears on. */
export interface SchemaVersion {
    schema: ParsedSchema;
    /** 0-based original-source line on which `varName = ...` appears. */
    line: number;
}

/**
 * Maps a schema-variable name to ALL of its definition sites, ordered by line.
 * Multiple entries arise when the same variable name is reused for different schemas.
 */
export type SchemaMap = Map<string, SchemaVersion[]>;

/**
 * Return the schema for `varName` that was most recently defined at or before `lineIdx`.
 * Returns null if the variable is unknown or not yet defined at that line.
 */
export function schemaVarAtLine(map: SchemaMap, varName: string, lineIdx: number): ParsedSchema | null {
    const versions = map.get(varName);
    if (!versions || versions.length === 0) { return null; }
    let result: SchemaVersion | undefined;
    for (const v of versions) {
        if (v.line <= lineIdx) { result = v; }
    }
    return result ? result.schema : null;
}

// ── Parenthesis matching ──────────────────────────────────────────────────────

/**
 * Find the matching closing parenthesis for the '(' at `openPos`.
 * Handles single-quoted, double-quoted, and triple-quoted strings and
 * escaped characters so that parentheses inside strings are ignored.
 * Returns the index of the matching ')' or -1 if not found.
 */
export function findMatchingParen(code: string, openPos: number): number {
    let depth = 0;
    let i = openPos;

    while (i < code.length) {
        const ch = code[i];

        // Triple-quoted strings (""" or ''')
        if ((ch === '"' || ch === "'") && code[i + 1] === ch && code[i + 2] === ch) {
            const q = ch + ch + ch;
            i += 3;
            while (i < code.length) {
                if (code[i] === '\\') { i += 2; continue; }
                if (code.substring(i, i + 3) === q) { i += 3; break; }
                i++;
            }
            continue;
        }

        // Single/double-quoted strings
        if (ch === '"' || ch === "'") {
            const q = ch;
            i++;
            while (i < code.length) {
                if (code[i] === '\\') { i += 2; continue; }
                if (code[i] === q) { i++; break; }
                i++;
            }
            continue;
        }

        // Python line comments: skip everything until the next newline
        if (ch === '#') {
            while (i < code.length && code[i] !== '\n') { i++; }
            continue;
        }

        if (ch === '(') {
            depth++;
        } else if (ch === ')') {
            depth--;
            if (depth === 0) { return i; }
        }
        i++;
    }
    return -1;
}

// ── StructType parsing ────────────────────────────────────────────────────────

/** Map a Spark type class name (e.g. "StringType") to a FieldType. */
function sparkTypeToFieldType(sparkType: string): FieldType {
    switch (sparkType.toLowerCase()) {
        case 'stringtype':    return 'string';
        case 'integertype':   return 'integer';
        case 'longtype':      return 'long';
        case 'doubletype':    return 'double';
        case 'floattype':     return 'float';
        case 'booleantype':   return 'boolean';
        case 'datetype':      return 'date';
        case 'timestamptype': return 'timestamp';
        case 'binarytype':    return 'binary';
        default:
            if (sparkType.toLowerCase().startsWith('decimaltype')) { return 'decimal'; }
            if (sparkType.toLowerCase().startsWith('arraytype'))   { return 'array'; }
            if (sparkType.toLowerCase().startsWith('maptype'))     { return 'map'; }
            if (sparkType.toLowerCase().startsWith('structtype'))  { return 'struct'; }
            return 'unknown';
    }
}

/**
 * Parse the content inside `StructType([...])` into a list of SchemaFields.
 * Handles both `StructField("name", IntegerType())` and
 * `StructField('name', IntegerType(), nullable=True)` forms.
 */
export function parseStructType(text: string): ParsedSchema {
    const fields: ParsedSchema = [];
    // Capture: name (group 1) and Spark type class name (group 2, without "()")
    const fieldRe = /StructField\s*\(\s*["'](\w+)["']\s*,\s*(\w+Type)/g;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(text)) !== null) {
        fields.push({ name: m[1], type: sparkTypeToFieldType(m[2]) });
    }
    return fields;
}

/**
 * Extract all schemas defined as `varname = StructType([...])` in Python source code.
 * Uses `findMatchingParen` so it correctly handles multi-line StructType definitions.
 */
export function extractStructTypeSchemas(code: string): SchemaMap {
    const schemaMap: SchemaMap = new Map();
    const assignRe = /(\w+)\s*=\s*StructType\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = assignRe.exec(code)) !== null) {
        const varName = m[1];
        const line = code.substring(0, m.index).split('\n').length - 1;
        const openPos = m.index + m[0].length - 1;
        const closePos = findMatchingParen(code, openPos);
        if (closePos === -1) { continue; }
        const content = code.substring(openPos + 1, closePos);
        const fields = parseStructType(content);
        if (fields.length > 0) {
            const versions = schemaMap.get(varName) ?? [];
            versions.push({ schema: fields, line });
            schemaMap.set(varName, versions);
        }
    }
    return schemaMap;
}

// ── DDL parsing ───────────────────────────────────────────────────────────────

/** Map a DDL type keyword to FieldType. */
function ddlTypeToFieldType(ddlType: string): FieldType {
    // Strip any precision/scale or angle-bracket parameters
    const upper = ddlType.toUpperCase().replace(/\s*[(<].*/, '').trim();
    switch (upper) {
        case 'INT':
        case 'INTEGER':  return 'integer';
        case 'BIGINT':
        case 'LONG':     return 'long';
        case 'STRING':
        case 'VARCHAR':
        case 'CHAR':     return 'string';
        case 'DOUBLE':   return 'double';
        case 'FLOAT':
        case 'REAL':     return 'float';
        case 'BOOLEAN':
        case 'BOOL':     return 'boolean';
        case 'DATE':     return 'date';
        case 'TIMESTAMP': return 'timestamp';
        case 'BINARY':   return 'binary';
        case 'DECIMAL':  return 'decimal';
        case 'ARRAY':    return 'array';
        case 'MAP':      return 'map';
        default:         return 'unknown';
    }
}

/**
 * Parse a DDL string like `"id INT, name STRING, ts TIMESTAMP"` into SchemaFields.
 */
export function parseDdlSchema(ddl: string): ParsedSchema {
    const fields: ParsedSchema = [];
    // Matches: colname TYPE (with optional precision/scale or angle-bracket params)
    const fieldRe = /(\w+)\s+(INT|INTEGER|BIGINT|LONG|STRING|VARCHAR(?:\(\d+\))?|CHAR(?:\(\d+\))?|DOUBLE|FLOAT|REAL|BOOLEAN|BOOL|DATE|TIMESTAMP|BINARY|DECIMAL(?:\s*\(\d+\s*,\s*\d+\))?|ARRAY<\w+>|MAP<\w+\s*,\s*\w+>)/gi;
    let m: RegExpExecArray | null;
    while ((m = fieldRe.exec(ddl)) !== null) {
        fields.push({ name: m[1], type: ddlTypeToFieldType(m[2]) });
    }
    return fields;
}

/** Regex that recognises a DDL-like string (contains a SQL type keyword). */
const DDL_TYPE_RE = /\b(INT|INTEGER|BIGINT|STRING|DOUBLE|FLOAT|BOOLEAN|TIMESTAMP|DATE|DECIMAL|BINARY)\b/i;

/**
 * Extract schemas defined as DDL strings: `varname = "id INT, name STRING"`.
 * Only strings that contain recognisable SQL type keywords are treated as DDL.
 */
export function extractDdlSchemas(code: string): SchemaMap {
    const schemaMap: SchemaMap = new Map();
    const assignRe = /(\w+)\s*=\s*(["'])/g;
    let m: RegExpExecArray | null;
    while ((m = assignRe.exec(code)) !== null) {
        const varName = m[1];
        const quoteChar = m[2];
        const line = code.substring(0, m.index).split('\n').length - 1;
        const strStart = m.index + m[0].length;
        let strEnd = strStart;
        while (strEnd < code.length) {
            if (code[strEnd] === '\\') { strEnd += 2; continue; }
            if (code[strEnd] === quoteChar) { break; }
            strEnd++;
        }
        const content = code.substring(strStart, strEnd);
        if (!DDL_TYPE_RE.test(content)) { continue; }
        const fields = parseDdlSchema(content);
        if (fields.length > 0) {
            const versions = schemaMap.get(varName) ?? [];
            versions.push({ schema: fields, line });
            schemaMap.set(varName, versions);
        }
    }
    return schemaMap;
}

// ── Line-continuation joining ─────────────────────────────────────────────────

/**
 * Count the net open-bracket depth of a single line of Python source,
 * ignoring brackets inside string literals and after a '#' comment marker.
 * Triple-quoted strings are not handled (rare in PySpark schema code).
 */
function netParenDepth(line: string): number {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inStr) {
            if (ch === '\\') { i++; continue; }   // skip escaped char
            if (ch === inStr) { inStr = null; }
        } else if (ch === '#') {
            break;                                  // rest is a comment
        } else if (ch === '"' || ch === "'") {
            inStr = ch;
        } else if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
        }
    }
    return depth;
}

/**
 * Join Python line-continuations into single logical lines.
 * Handles both:
 *   • explicit backslash continuations  (`df = df \\\n    .select(...)`)
 *   • implicit paren/bracket continuations (`spark.createDataFrame(\n    [...],\n    schema=s\n)`)
 *
 * Returns:
 *   joinedLines – merged lines (may be shorter than the input array)
 *   lineMap     – maps each joined-line index → the original first-line index
 */
export function joinContinuationLines(lines: string[]): {
    joinedLines: string[];
    lineMap: number[];
} {
    const joinedLines: string[] = [];
    const lineMap: number[] = [];
    let i = 0;
    while (i < lines.length) {
        let joined = lines[i];
        const origIdx = i;
        // Track bracket depth INCREMENTALLY across individual original lines.
        // Calling netParenDepth(joined) on the whole accumulated string is wrong:
        // a line like `foo([  # inline comment` has depth 2, but after appending
        // the next line the '#' makes netParenDepth treat the appended code as
        // comment text, so brackets in subsequent lines are never seen.
        let depth = netParenDepth(lines[i]);
        while (i + 1 < lines.length) {
            const trimmed = joined.trimEnd();
            const isBackslash = trimmed.endsWith('\\');
            if (!isBackslash && depth <= 0) { break; }
            i++;
            if (isBackslash) {
                joined = trimmed.slice(0, -1).trimEnd() + ' ' + lines[i].trimStart();
            } else {
                joined = joined + ' ' + lines[i].trimStart();
            }
            depth += netParenDepth(lines[i]);
        }
        joinedLines.push(joined);
        lineMap.push(origIdx);
        i++;
    }
    return { joinedLines, lineMap };
}

// ── Fuzzy column suggestion ───────────────────────────────────────────────────

/**
 * Compute the Levenshtein (edit) distance between two strings.
 * Uses a space-efficient single-row DP approach.
 */
export function levenshtein(a: string, b: string): number {
    const n = b.length;
    const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let prev = dp[0];
        dp[0] = i;
        for (let j = 1; j <= n; j++) {
            const temp = dp[j];
            dp[j] = a[i - 1] === b[j - 1]
                ? prev
                : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = temp;
        }
    }
    return dp[n];
}

/**
 * Return up to 3 column names from `fields` whose Levenshtein distance from
 * `name` is ≤ `maxDist`, sorted closest-first.
 */
export function suggestColumns(name: string, fields: SchemaField[], maxDist = 2): string[] {
    return fields
        .map(f => ({ name: f.name, dist: levenshtein(name, f.name) }))
        .filter(x => x.dist <= maxDist && x.dist > 0)
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 3)
        .map(x => x.name);
}
