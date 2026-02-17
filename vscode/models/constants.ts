/**
 * Constants for CatalystOps extension
 */

import { Severity } from './types';

/** Extension identifier */
export const EXTENSION_ID = 'catalystops';

/** Diagnostic source name shown in Problems panel */
export const DIAGNOSTIC_SOURCE = 'CatalystOps';

/** Sentinel markers for cluster script output */
export const RESULT_START_MARKER = '__CATALYSTOPS_RESULT__';
export const RESULT_END_MARKER = '__CATALYSTOPS_END__';

/** Cost weights for plan operations */
export const COST_WEIGHTS = {
    broadcastHashJoin: 1,
    shuffledHashJoin: 30,
    sortMergeJoin: 50,
    broadcastNestedLoopJoin: 80,
    cartesianProduct: 1000,
    exchange: 20,
    sort: 10,
    aggregate: 5,
    filter: 1,
    project: 1,
    missingStatistics: 15,
} as const;

/** Map severity to VS Code DiagnosticSeverity values (0=Error, 1=Warning, 2=Info, 3=Hint) */
export const SEVERITY_TO_DIAGNOSTIC: Record<Severity, number> = {
    [Severity.CRITICAL]: 0,   // Error
    [Severity.WARNING]: 1,    // Warning
    [Severity.INFO]: 2,       // Information
    [Severity.SUGGESTION]: 3, // Hint
};

/** Command Execution API polling configuration */
export const POLLING = {
    initialDelayMs: 200,
    maxDelayMs: 10000,
    backoffMultiplier: 1.5,
    timeoutMs: 60000,
} as const;

/** Actions that need to be neutralized in safety wrapper */
export const DANGEROUS_ACTIONS = [
    'write', 'save', 'saveAsTable', 'insertInto',
    'collect', 'toLocalIterator', 'toPandas', 'to_pandas_on_spark',
    'show', 'display', 'count', 'take', 'first', 'head',
    'foreach', 'foreachBatch', 'foreachPartition',
    'start', // writeStream.start()
] as const;

/** Python code patterns that indicate PySpark usage */
export const PYSPARK_INDICATORS = [
    'from pyspark',
    'import pyspark',
    'spark.read',
    'spark.sql',
    'SparkSession',
    'DataFrame',
    '.join(',
    '.groupBy(',
    '.agg(',
    '.filter(',
    '.select(',
    '.withColumn(',
] as const;
