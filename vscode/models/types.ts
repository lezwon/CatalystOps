/**
 * TypeScript interfaces matching Python spark_optimizer/models.py
 */

export enum Severity {
    CRITICAL = 'critical',
    WARNING = 'warning',
    INFO = 'info',
    SUGGESTION = 'suggestion',
}

export const SEVERITY_PRIORITY: Record<Severity, number> = {
    [Severity.CRITICAL]: 1,
    [Severity.WARNING]: 2,
    [Severity.INFO]: 3,
    [Severity.SUGGESTION]: 4,
};

export enum IssueCategory {
    JOIN = 'join',
    SHUFFLE = 'shuffle',
    PARTITIONING = 'partitioning',
    CACHING = 'caching',
    DATA_SKEW = 'data_skew',
    SPILL = 'spill',
    RESOURCE = 'resource',
    SERIALIZATION = 'serialization',
    CODE = 'code',
    CONFIGURATION = 'configuration',
    SECURITY = 'security',
}

export interface Fix {
    description: string;
    code?: string;
    configChanges?: Record<string, string>;
}

export interface Issue {
    id: string;
    severity: Severity;
    category: IssueCategory;
    title: string;
    description: string;
    location?: string;
    impact?: string;
    fix: Fix;
    metadata?: Record<string, string>;
}

export interface PlanOperator {
    name: string;
    nodeName: string;
    children: PlanOperator[];
    metrics: Record<string, string>;
    metadata: Record<string, string>;
}

export interface ExecutionPlanInfo {
    physicalPlan: string;
    logicalPlan: string;
    operators: PlanOperator[];
    totalStages: number;
    totalShuffles: number;
    joinCount: number;
    aggregationCount: number;
}

export interface ClusterInfo {
    clusterName?: string;
    workers: number;
    coresPerWorker: number;
    totalCores: number;
    executorMemory: string;
    driverMemory: string;
    sparkVersion: string;
    photonEnabled: boolean;
    adaptiveQueryEnabled: boolean;
    instanceType?: string;
    sparkConfigs: Record<string, string>;
}

export interface DataStats {
    estimatedRows?: number;
    estimatedSizeBytes?: number;
    partitionCount: number;
    columnCount: number;
    hasNestedTypes: boolean;
    nullPercentages: Record<string, number>;
    partitionSizes: number[];
    skewRatio?: number;
}

export interface IssueSummary {
    critical: number;
    warnings: number;
    info: number;
    suggestions: number;
}

export interface AnalysisResult {
    analysisTime: string;
    planDurationMs?: number;
    dataframeName?: string;
    summary: IssueSummary;
    cluster: ClusterInfo;
    executionPlan: ExecutionPlanInfo;
    dataStats: DataStats;
    issues: Issue[];
    metadata: Record<string, string>;
}

/** Local code analysis issue with line/column info for VS Code diagnostics */
export interface CodeIssue extends Issue {
    line: number;
    column: number;
    endLine?: number;
    endColumn?: number;
}

/** Result from cluster dry-run analysis */
export interface DryRunResult {
    analysisResults: AnalysisResult[];
    rawPlan?: string;
    error?: string;
}

/** Databricks command execution state */
export type CommandStatus = 'Queued' | 'Running' | 'Cancelling' | 'Finished' | 'Cancelled' | 'Error';

export interface CommandResult {
    id: string;
    status: CommandStatus;
    results?: {
        resultType: string;
        data?: string;
        cause?: string;
    };
}

export interface ClusterState {
    clusterId: string;
    state: 'PENDING' | 'RUNNING' | 'RESTARTING' | 'RESIZING' | 'TERMINATING' | 'TERMINATED' | 'ERROR' | 'UNKNOWN';
    stateMessage?: string;
}
