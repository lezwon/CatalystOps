/**
 * Schema tracking — maps DataFrame variable names to their inferred schemas
 * by simulating assignment and transformation statements line-by-line.
 */

import {
    ParsedSchema,
    SchemaField,
    SchemaMap,
    SchemaVersion,
    FieldType,
    parseDdlSchema,
    findMatchingParen,
    joinContinuationLines,
    schemaVarAtLine,
    extractStructTypeSchemas,
    extractDdlSchemas,
} from './schemaExtractor';
import functionTypesJson from './functionTypes.json';

// ── UDF return-type extraction ─────────────────────────────────────────────────

/** Map from PySpark type constructor name → FieldType. */
const SPARK_TYPE_MAP: Record<string, FieldType> = {
    StringType:    'string',
    IntegerType:   'integer',
    IntType:       'integer',
    LongType:      'long',
    DoubleType:    'double',
    FloatType:     'float',
    BooleanType:   'boolean',
    DateType:      'date',
    TimestampType: 'timestamp',
    BinaryType:    'binary',
    DecimalType:   'decimal',
    ArrayType:     'array',
    MapType:       'map',
    StructType:    'struct',
};

/** Parse a PySpark type constructor name into a FieldType, e.g. "IntegerType" → "integer". */
function parseSparkType(typeStr: string): FieldType {
    const typeName = /^(\w+Type)/.exec(typeStr.trim())?.[1];
    return (typeName && SPARK_TYPE_MAP[typeName]) ? SPARK_TYPE_MAP[typeName] : 'unknown';
}

/** Extract the return type from the argument list of a udf() call. */
function extractUdfReturnTypeFromArgs(argsText: string): FieldType {
    // Keyword argument: returnType=SomeType()
    const kwMatch = /returnType\s*=\s*(\w+Type)/.exec(argsText);
    if (kwMatch) { return parseSparkType(kwMatch[1]); }
    // Last positional type: ...SomeType() at the end
    const posMatch = /(\w+Type)\s*\(\s*\)\s*$/.exec(argsText.trim());
    if (posMatch) { return parseSparkType(posMatch[1]); }
    // Single-arg @udf(SomeType()) or udf(SomeType())
    const singleMatch = /^(\w+Type)\s*\(/.exec(argsText.trim());
    if (singleMatch) { return parseSparkType(singleMatch[1]); }
    return 'unknown';
}

/**
 * Scan source code for UDF declarations and return a map of
 * udf variable/function name → declared return FieldType.
 *
 * Recognises:
 *   my_udf = udf(lambda x: x, IntegerType())
 *   my_udf = udf(my_func, returnType=StringType())
 *   @udf(returnType=DoubleType())
 *   def my_udf(x): ...
 *   @udf(LongType())
 *   def my_udf(x): ...
 */
export function extractUdfReturnTypes(code: string): Map<string, FieldType> {
    const udfTypes = new Map<string, FieldType>();
    const lines = code.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('#')) { continue; }

        // Pattern 1: var = udf(...) or var = F.udf(...)
        const assignMatch = /^(\w+)\s*=\s*(?:F\.|functions\.)?udf\s*\(/.exec(trimmed);
        if (assignMatch) {
            const openIdx = trimmed.indexOf('(', assignMatch[0].length - 1);
            if (openIdx !== -1) {
                const closeIdx = findMatchingParen(trimmed, openIdx);
                if (closeIdx !== -1) {
                    const argsText = trimmed.substring(openIdx + 1, closeIdx);
                    const returnType = extractUdfReturnTypeFromArgs(argsText);
                    if (returnType !== 'unknown') { udfTypes.set(assignMatch[1], returnType); }
                }
            }
            continue;
        }

        // Pattern 2: @udf(...) decorator — next non-blank/non-comment line must be def name
        const decoratorMatch = /^@(?:F\.|functions\.)?udf\s*\(/.exec(trimmed);
        if (decoratorMatch) {
            let returnType: FieldType = 'unknown';
            const openIdx = trimmed.indexOf('(', decoratorMatch[0].length - 1);
            if (openIdx !== -1) {
                const closeIdx = findMatchingParen(trimmed, openIdx);
                if (closeIdx !== -1) {
                    returnType = extractUdfReturnTypeFromArgs(trimmed.substring(openIdx + 1, closeIdx));
                }
            }
            for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
                const next = lines[j].trim();
                if (!next || next.startsWith('#')) { continue; }
                const defMatch = /^def\s+(\w+)\s*\(/.exec(next);
                if (defMatch && returnType !== 'unknown') { udfTypes.set(defMatch[1], returnType); }
                break;
            }
        }
    }

    return udfTypes;
}

// ── Write operation metadata ───────────────────────────────────────────────────

export interface WriteOperationColumn {
    name: string;
    type: FieldType;
}

export interface WriteOperation {
    varName: string;
    writeLine: number;       // 0-based line of the .write / .writeStream
    isStreaming: boolean;
    destination?: string;    // table name or path, if parseable on that line
    columns: WriteOperationColumn[];
}

/** Map from PySpark function name → column type category ('numeric' | 'string' | 'date'). */
const FUNC_TYPES = new Map<string, string>(
    (Object.entries(functionTypesJson) as [string, string][])
        .filter(([k]) => !k.startsWith('_'))
);

/** Return type of a function category (what the function produces). */
const CATEGORY_RETURN_TYPE: Record<string, FieldType> = {
    string:  'string',
    numeric: 'double',
    date:    'date',
};

/**
 * Infer the FieldType produced by a PySpark expression.
 * Handles built-in typed functions and UDF calls with a declared return type.
 * Returns 'unknown' for anything more complex.
 */
function inferExprType(expr: string, udfTypes: Map<string, FieldType> = new Map()): FieldType {
    const funcMatch = /^(?:F\.|functions\.)?(\w+)\s*\(/.exec(expr.trim());
    if (funcMatch) {
        const funcName = funcMatch[1];
        const cat = FUNC_TYPES.get(funcName);
        if (cat) { return CATEGORY_RETURN_TYPE[cat] ?? 'unknown'; }
        // Look up the UDF return type if this is a user-defined function call
        const udfType = udfTypes.get(funcName);
        if (udfType) { return udfType; }
    }
    return 'unknown';
}

export interface SchemaBinding {
    /** null = schema is unknown (e.g. after a join or external read) */
    schema: ParsedSchema | null;
    definedAtLine: number;
}

/** Current schema (or null) for each DataFrame variable. */
export type DfSchemaMap = Map<string, ParsedSchema | null>;

/** Per-variable ordered list of (schema, line) pairs. */
export type BindingHistory = Map<string, SchemaBinding[]>;

// ── Internal helpers ──────────────────────────────────────────────────────────

function addBinding(
    history: BindingHistory,
    varName: string,
    schema: ParsedSchema | null,
    line: number,
): void {
    if (!history.has(varName)) { history.set(varName, []); }
    history.get(varName)!.push({ schema, definedAtLine: line });
}

/**
 * Extract the content between the first '(' and its balanced ')' in `text`,
 * starting the search at `startOffset`. Respects nested parens and strings.
 */
function extractParenContent(text: string, startOffset = 0): string | null {
    const openIdx = text.indexOf('(', startOffset);
    if (openIdx === -1) { return null; }
    const closeIdx = findMatchingParen(text, openIdx);
    if (closeIdx === -1) { return null; }
    return text.substring(openIdx + 1, closeIdx);
}

/**
 * Find the index of the first top-level comma in `text`
 * (not inside parentheses, brackets, braces, or strings).
 */
function findFirstComma(text: string): number {
    let depth = 0;
    let inStr: string | null = null;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (ch === '\\') { i++; continue; }
            if (ch === inStr) { inStr = null; }
        } else if (ch === '"' || ch === "'") {
            inStr = ch;
        } else if (ch === '(' || ch === '[' || ch === '{') {
            depth++;
        } else if (ch === ')' || ch === ']' || ch === '}') {
            depth--;
        } else if (ch === ',' && depth === 0) {
            return i;
        }
    }
    return -1;
}

/**
 * Extract all simple string-literal values from a comma-separated argument list.
 * Returns null if parsing fails or the list is empty.
 */
function extractStringArgs(argsText: string): string[] | null {
    const strings: string[] = [];
    const strRe = /["']([^"'\\]*)["']/g;
    let m: RegExpExecArray | null;
    while ((m = strRe.exec(argsText)) !== null) {
        strings.push(m[1]);
    }
    return strings.length > 0 ? strings : null;
}

// ── Method classification ─────────────────────────────────────────────────────

/** Methods that pass the schema through unchanged. */
const PASSTHRU_METHODS = new Set([
    'filter', 'where', 'alias', 'distinct', 'limit', 'sample',
    'dropna', 'fillna', 'na', 'cache', 'persist', 'unpersist',
    'repartition', 'coalesce', 'orderBy', 'sort', 'sortWithinPartitions',
    'localCheckpoint', 'checkpoint',
]);

/** Methods that produce an unknown schema (join, set operations, aggregations). */
const NULL_SCHEMA_METHODS = new Set([
    'join', 'union', 'unionAll', 'unionByName',
    'intersect', 'intersectAll', 'except', 'exceptAll', 'crossJoin',
    'agg', 'groupBy', 'rollup', 'cube', 'pivot',
    'toDF', 'toPandas', 'toJSON', 'to_pandas_on_spark',
]);

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Scan Python source code line-by-line and build a BindingHistory that maps
 * every assigned variable name to the sequence of schemas it has held.
 *
 * Recognised creation patterns:
 *   df = spark.createDataFrame(data, schema_var)   — looks up schema_var
 *   df = spark.createDataFrame(data, "id INT, ...")  — parses inline DDL
 *
 * Recognised transformation patterns:
 *   .filter/.where/.distinct/... → same schema
 *   .select("a","b")             → subset of fields (string-only args, no *)
 *   .drop("col")                 → remove field
 *   .withColumn("new", ...)      → add/replace field with unknown type
 *   .withColumnRenamed("a","b")  → rename field
 *   .join/.union/...             → null (unknown schema)
 */
export function buildDfSchemaMap(
    code: string,
    structSchemas: SchemaMap,
    ddlSchemas: SchemaMap,
): BindingHistory {
    const history: BindingHistory = new Map();
    const udfTypes = extractUdfReturnTypes(code);

    // Merge both schema maps into one, preserving all definition sites
    const allSchemas: SchemaMap = new Map(structSchemas);
    for (const [key, versions] of ddlSchemas) {
        const existing = allSchemas.get(key) ?? [];
        allSchemas.set(key, [...existing, ...versions].sort((a, b) => a.line - b.line));
    }
    const { joinedLines: lines, lineMap } = joinContinuationLines(code.split('\n'));

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        const trimmed = line.trim();

        // Skip comment lines and lines without an assignment operator
        if (trimmed.startsWith('#') || !trimmed.includes('=')) { continue; }

        // Match simple assignment:  varname = <rhs>
        const assignMatch = /^(\w+)\s*=\s*(.+)/.exec(trimmed);
        if (!assignMatch) { continue; }

        const varName = assignMatch[1];
        const rhs = assignMatch[2].trim();

        // Skip Python keywords that can appear before '='
        if (/^(if|for|while|return|import|from|class|def|else|elif|try|except|finally|with|assert|raise|yield|lambda|pass|break|continue|global|nonlocal|del|True|False|None|and|or|not|in|is)\b/.test(varName)) {
            continue;
        }

        // ── spark.read.schema(schema).<format>(...) ──────────────────────────
        // Handles: spark.read.schema(var).json(path)
        //          spark.read.format("json").schema(var).load(path)
        if (/spark\.read/.test(rhs) && /\.schema\s*\(/.test(rhs)) {
            const schemaCallMatch = /\.schema\s*\(/.exec(rhs);
            if (schemaCallMatch) {
                // Position of the '(' in '.schema('
                const openPos = schemaCallMatch.index + schemaCallMatch[0].length - 1;
                const content = extractParenContent(rhs, openPos);
                if (content !== null) {
                    const trimmedContent = content.trim();
                    let schema: ParsedSchema | null = null;
                    const varRefMatch = /^(\w+)$/.exec(trimmedContent);
                    if (varRefMatch) {
                        schema = schemaVarAtLine(allSchemas, varRefMatch[1], lineMap[lineIdx]);
                    } else {
                        const strMatch = /^["']([^"']+)["']$/.exec(trimmedContent);
                        if (strMatch) {
                            const parsed = parseDdlSchema(strMatch[1]);
                            if (parsed.length > 0) { schema = parsed; }
                        }
                    }
                    addBinding(history, varName, schema, lineIdx);
                    continue;
                }
            }
            addBinding(history, varName, null, lineIdx);
            continue;
        }

        // ── spark.createDataFrame(data, schema) ───────────────────────────────
        // Handles positional:  spark.createDataFrame(data, schema_var)
        //          keyword:    spark.createDataFrame(data, schema=schema_var)
        //          inline DDL: spark.createDataFrame(data, "id INT, name STRING")
        if (/spark\.createDataFrame\s*\(/.test(rhs)) {
            const searchStart = rhs.search(/spark\.createDataFrame\s*\(/);
            const parenContent = extractParenContent(rhs, searchStart);
            if (parenContent !== null) {
                // Priority 1: keyword argument schema=<value>
                const kwMatch = /\bschema\s*=\s*(?!None\b)(["']([^"']+)["']|(\w+))/.exec(parenContent);
                let schemaArg: string | null = null;
                if (kwMatch) {
                    schemaArg = kwMatch[1].trim();
                } else {
                    // Priority 2: second positional argument
                    const commaIdx = findFirstComma(parenContent);
                    if (commaIdx !== -1) {
                        schemaArg = parenContent.substring(commaIdx + 1).trim();
                    }
                }

                if (schemaArg !== null) {
                    let schema: ParsedSchema | null = null;
                    // Variable reference?
                    const varRefMatch = /^(\w+)\s*$/.exec(schemaArg);
                    if (varRefMatch) {
                        schema = schemaVarAtLine(allSchemas, varRefMatch[1], lineMap[lineIdx]);
                    } else {
                        // Inline DDL string?
                        const strMatch = /^["']([^"']+)["']$/.exec(schemaArg);
                        if (strMatch) {
                            const parsed = parseDdlSchema(strMatch[1]);
                            if (parsed.length > 0) { schema = parsed; }
                        }
                    }
                    addBinding(history, varName, schema, lineIdx);
                    continue;
                }
            }
            addBinding(history, varName, null, lineIdx);
            continue;
        }

        // ── DataFrame transformation: df2 = df.method(...) ───────────────────
        const chainMatch = /^(\w+)\.(\w+)\s*\(/.exec(rhs);
        if (!chainMatch) { continue; }

        const sourceDf = chainMatch[1];
        const method   = chainMatch[2];

        // Ignore non-DataFrame roots
        if (sourceDf === 'spark' || sourceDf === 'sc' || sourceDf === 'sqlContext') { continue; }

        const prevSchema = schemaAtLine(history, sourceDf, lineIdx - 1);

        if (PASSTHRU_METHODS.has(method)) {
            addBinding(history, varName, prevSchema, lineIdx);
            continue;
        }

        if (method === 'select') {
            if (prevSchema) {
                const parenContent = extractParenContent(rhs);
                if (parenContent !== null && !parenContent.includes('*')) {
                    const cols = extractStringArgs(parenContent);
                    if (cols && cols.length > 0 && !cols.includes('*')) {
                        const subset: ParsedSchema = cols
                            .map(c => prevSchema.find(f => f.name === c))
                            .filter((f): f is SchemaField => f !== undefined);
                        addBinding(history, varName, subset.length > 0 ? subset : prevSchema, lineIdx);
                        continue;
                    }
                }
            }
            addBinding(history, varName, prevSchema, lineIdx);
            continue;
        }

        if (method === 'drop') {
            if (prevSchema) {
                const parenContent = extractParenContent(rhs);
                if (parenContent !== null) {
                    const cols = extractStringArgs(parenContent);
                    if (cols) {
                        const newSchema = prevSchema.filter(f => !cols.includes(f.name));
                        addBinding(history, varName, newSchema, lineIdx);
                        continue;
                    }
                }
            }
            addBinding(history, varName, prevSchema, lineIdx);
            continue;
        }

        if (method === 'withColumn') {
            if (prevSchema) {
                const parenContent = extractParenContent(rhs);
                if (parenContent !== null) {
                    const firstStr = /["']([^"'\\]*)["']/.exec(parenContent);
                    if (firstStr) {
                        const newColName = firstStr[1];
                        // Try to infer the return type from the expression after the column name arg
                        const afterFirstStr = parenContent.substring(firstStr.index + firstStr[0].length);
                        const commaIdx = findFirstComma(afterFirstStr);
                        const exprPart = commaIdx !== -1 ? afterFirstStr.substring(commaIdx + 1).trim() : '';
                        const inferredType = inferExprType(exprPart, udfTypes);
                        const newSchema: ParsedSchema = [
                            ...prevSchema.filter(f => f.name !== newColName),
                            { name: newColName, type: inferredType },
                        ];
                        addBinding(history, varName, newSchema, lineIdx);
                        continue;
                    }
                }
            }
            addBinding(history, varName, prevSchema, lineIdx);
            continue;
        }

        if (method === 'withColumnRenamed') {
            if (prevSchema) {
                const parenContent = extractParenContent(rhs);
                if (parenContent !== null) {
                    const strArgs = extractStringArgs(parenContent);
                    if (strArgs && strArgs.length >= 2) {
                        const [oldName, newName] = strArgs;
                        const newSchema: ParsedSchema = prevSchema.map(f =>
                            f.name === oldName ? { name: newName, type: f.type } : f,
                        );
                        addBinding(history, varName, newSchema, lineIdx);
                        continue;
                    }
                }
            }
            addBinding(history, varName, prevSchema, lineIdx);
            continue;
        }

        if (NULL_SCHEMA_METHODS.has(method)) {
            addBinding(history, varName, null, lineIdx);
            continue;
        }
    }

    return history;
}

// ── Write operation finder ─────────────────────────────────────────────────────

const NON_DF_NAMES = new Set(['F', 'functions', 'spark', 'sc', 'sqlContext', 'col', 'lit']);

/**
 * Scan the source code for DataFrame write/writeStream operations and collect
 * each one with its variable name, line, streaming flag, destination (if
 * parseable on the same line), and output column list from the schema history.
 */
export function findWriteOperations(
    code: string,
    history: BindingHistory,
): WriteOperation[] {
    const ops: WriteOperation[] = [];
    const seen = new Set<number>();   // deduplicate by line number
    const lines = code.split('\n');
    const writeRe = /\b([A-Za-z_]\w*)\.(writeStream|write)\b/g;
    let m: RegExpExecArray | null;

    while ((m = writeRe.exec(code)) !== null) {
        const varName = m[1];
        const writeMethod = m[2];
        if (NON_DF_NAMES.has(varName)) { continue; }

        // Skip if followed immediately by '(' — that's file.write(data), not Spark
        const afterMatch = code.substring(m.index + m[0].length).trimStart();
        if (afterMatch.startsWith('(')) { continue; }

        const writeLine = code.substring(0, m.index).split('\n').length - 1;
        if (seen.has(writeLine)) { continue; }
        seen.add(writeLine);

        const lineText = lines[writeLine] ?? '';
        // Skip comment lines and noqa-suppressed lines
        if (lineText.trim().startsWith('#')) { continue; }
        if (/# noqa: catalystops\b/i.test(lineText)) { continue; }

        const schema = schemaAtLine(history, varName, writeLine);
        const columns: WriteOperationColumn[] = schema
            ? schema.map(f => ({ name: f.name, type: f.type }))
            : [];

        // Try to extract an output destination from the same line (simple cases)
        const destMatch =
            /\.saveAsTable\s*\(\s*["']([^"']+)["']/.exec(lineText) ??
            /\.(?:parquet|json|csv|orc|text|delta|avro)\s*\(\s*["']([^"']+)["']/.exec(lineText) ??
            /(?:path|location)\s*=\s*["']([^"']+)["']/.exec(lineText);

        ops.push({
            varName,
            writeLine,
            isStreaming: writeMethod === 'writeStream',
            destination: destMatch?.[1],
            columns,
        });
    }

    return ops;
}

/**
 * Convenience entry point: extract schemas from `code` and return all
 * write/writeStream operations with their output column lists.
 */
export function analyzeWriteOps(code: string): WriteOperation[] {
    const structSchemas = extractStructTypeSchemas(code);
    const ddlSchemas    = extractDdlSchemas(code);
    const history = buildDfSchemaMap(code, structSchemas, ddlSchemas);
    return findWriteOperations(code, history);
}

/**
 * Look up the most recent schema binding for `varName` at or before `lineIdx`.
 * Returns `null` if the schema is unknown, or `undefined` (→ treated as null
 * by callers) if `varName` has never been bound.
 */
export function schemaAtLine(
    history: BindingHistory,
    varName: string,
    lineIdx: number,
): ParsedSchema | null {
    const bindings = history.get(varName);
    if (!bindings) { return null; }
    let result: SchemaBinding | undefined;
    for (const binding of bindings) {
        if (binding.definedAtLine <= lineIdx) { result = binding; }
    }
    return result ? result.schema : null;
}
