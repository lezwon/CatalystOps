/**
 * Databricks Asset Bundle YAML linter.
 *
 * Provides VS Code diagnostics for databricks.yml and included resource files:
 *  - Unknown / invalid top-level keys
 *  - Missing or non-existent python_file / notebook_path references
 *  - job_cluster_key in a task referencing an undefined cluster
 *  - Mutually exclusive fields (schedule+continuous, job_cluster_key+existing_cluster_id)
 *  - Invalid enum values (data_security_mode, runtime_engine, pause_status, target mode, permission level)
 *  - spark_version format
 *  - num_workers / max_concurrent_runs / autotermination_minutes range
 *  - data_security_mode: SINGLE_USER requires single_user_name
 *  - Deprecated field warnings (photon: true, jar_uri)
 *  - data_security_mode: NONE in production target (security warning)
 *  - task_key uniqueness within a job
 *  - Missing task_key
 *  - Malformed target workspace host
 *  - include patterns that match no files
 *  - Alert v2 schema mistakes (condition→evaluation, wrong schedule keys, subscriptions location)
 *  - Alert comparison_operator enum, required alert fields
 *  - Dashboard/alert permission levels vs job permission levels
 *  - Volumes: warns if "permissions" used instead of "grants"
 *  - Job environments: spec.client required
 *  - Task run_if enum validation
 *  - Trigger periodic.unit enum validation
 *  - Job health rules metric/op enum validation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { BundleConfig } from '../databricks/bundleParser';

const BUNDLE_SOURCE = 'CatalystOps (bundle)';

// ─── Schema constants ─────────────────────────────────────────────────────────

const VALID_TOP_LEVEL_KEYS = new Set([
    'bundle', 'include', 'variables', 'resources', 'targets', 'artifacts',
    'workspace', 'permissions', 'presets', 'run_as', 'sync', 'scripts',
    'python', 'experimental',
]);

const VALID_RESOURCE_TYPES = new Set([
    'jobs', 'pipelines', 'clusters', 'dashboards', 'alerts',
    'quality_monitors', 'experiments', 'models', 'registered_models',
    'schemas', 'volumes', 'sql_warehouses', 'instance_pools',
]);

const VALID_DATA_SECURITY_MODES = new Set([
    'SINGLE_USER', 'USER_ISOLATION', 'NONE',
    'LEGACY_TABLE_ACL', 'LEGACY_PASSTHROUGH',
    'LEGACY_SINGLE_USER', 'LEGACY_SINGLE_USER_STANDARD',
]);

const VALID_RUNTIME_ENGINES = new Set(['PHOTON', 'STANDARD']);

const VALID_PAUSE_STATUSES = new Set(['PAUSED', 'UNPAUSED']);

const VALID_TARGET_MODES = new Set(['development', 'production']);

// Job-level permission levels
const VALID_JOB_PERMISSION_LEVELS = new Set([
    'CAN_VIEW', 'CAN_MANAGE_RUN', 'CAN_MANAGE', 'IS_OWNER',
]);

// Dashboard / alert / pipeline permission levels (differ from jobs)
const VALID_RESOURCE_PERMISSION_LEVELS = new Set([
    'CAN_READ', 'CAN_RUN', 'CAN_EDIT', 'CAN_MANAGE', 'IS_OWNER',
]);

// Top-level bundle permissions (broadest set)
const VALID_BUNDLE_PERMISSION_LEVELS = new Set([
    'CAN_VIEW', 'CAN_RUN', 'CAN_MANAGE', 'CAN_MANAGE_RUN', 'IS_OWNER',
    'CAN_READ', 'CAN_EDIT',
]);

const VALID_PERIODIC_UNITS = new Set(['HOURS', 'DAYS', 'WEEKS']);

const VALID_TABLE_UPDATE_CONDITIONS = new Set(['ANY_UPDATED']);

const VALID_RUN_IF_VALUES = new Set([
    'ALL_SUCCESS', 'ALL_DONE', 'NONE_FAILED',
    'AT_LEAST_ONE_SUCCESS', 'ALL_FAILED', 'AT_LEAST_ONE_FAILED',
]);

const VALID_HEALTH_METRICS = new Set([
    'RUN_DURATION_SECONDS', 'STREAMING_BACKLOG_SECONDS', 'STREAMING_BACKLOG_RECORDS',
]);

const VALID_HEALTH_OPS = new Set(['GREATER_THAN']);

const VALID_ALERT_COMPARISON_OPERATORS = new Set([
    'EQUAL', 'NOT_EQUAL', 'GREATER_THAN', 'GREATER_THAN_OR_EQUAL',
    'LESS_THAN', 'LESS_THAN_OR_EQUAL',
]);

const SPARK_VERSION_RE = /^\d+\.\d+\.x(-scala\d+\.\d+)?(-cpu-ml|-gpu-ml|-photon)?$/;

// ─── Provider class ───────────────────────────────────────────────────────────

export class BundleLintProvider {
    private readonly diagnostics: vscode.DiagnosticCollection;
    private bundle: BundleConfig | undefined;
    private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    constructor() {
        this.diagnostics = vscode.languages.createDiagnosticCollection('catalystops-bundle');
    }

    /** Called from extension.ts when the bundle config is refreshed. */
    setBundle(bundle: BundleConfig | undefined): void {
        this.bundle = bundle;
        if (!bundle) {
            this.diagnostics.clear();
            return;
        }
        // Re-lint all currently open bundle files
        for (const doc of vscode.workspace.textDocuments) {
            if (this.isBundleFile(doc.uri.fsPath)) {
                this.lintDocument(doc);
            }
        }
    }

    /** Returns true if the file is databricks.yml or one of the included resource files. */
    isBundleFile(fsPath: string): boolean {
        if (!this.bundle) { return false; }
        const resolved = path.resolve(fsPath);
        return (
            resolved === path.resolve(this.bundle.bundlePath) ||
            this.bundle.includedFiles.some(f => path.resolve(f) === resolved)
        );
    }

    lintDocument(doc: vscode.TextDocument): void {
        if (!this.bundle || !this.isBundleFile(doc.uri.fsPath)) { return; }

        const isRoot = path.resolve(doc.uri.fsPath) === path.resolve(this.bundle.bundlePath);
        const fileDir = path.dirname(doc.uri.fsPath);
        const bundleRoot = path.dirname(this.bundle.bundlePath);

        const diags = lintYaml(doc, fileDir, bundleRoot, isRoot);
        this.diagnostics.set(doc.uri, diags);
    }

    lintDocumentDebounced(doc: vscode.TextDocument, delayMs = 600): void {
        const key = doc.uri.toString();
        clearTimeout(this.debounceTimers.get(key));
        this.debounceTimers.set(key, setTimeout(() => {
            this.debounceTimers.delete(key);
            this.lintDocument(doc);
        }, delayMs));
    }

    clearDocument(uri: vscode.Uri): void {
        this.diagnostics.delete(uri);
    }

    dispose(): void {
        this.diagnostics.dispose();
        for (const t of this.debounceTimers.values()) { clearTimeout(t); }
    }
}

// ─── Core lint logic ──────────────────────────────────────────────────────────

function lintYaml(
    doc: vscode.TextDocument,
    fileDir: string,
    bundleRoot: string,
    isRoot: boolean,
): vscode.Diagnostic[] {
    const text = doc.getText();
    const lines = text.split('\n');

    let parsed: Record<string, unknown>;
    try {
        const raw = yaml.load(text);
        if (!raw || typeof raw !== 'object') { return []; }
        parsed = raw as Record<string, unknown>;
    } catch {
        return []; // syntax errors are handled by the YAML extension
    }

    const diags: vscode.Diagnostic[] = [];

    // ── 1. Unknown top-level keys (root file only — resource files have no top-level bundle key) ──
    if (isRoot) {
        for (const key of Object.keys(parsed)) {
            if (!VALID_TOP_LEVEL_KEYS.has(key)) {
                const d = diagForKey(lines, key,
                    `Unknown top-level key "${key}". Valid keys: ${[...VALID_TOP_LEVEL_KEYS].join(', ')}`,
                    vscode.DiagnosticSeverity.Warning);
                if (d) { diags.push(d); }
            }
        }
    }

    // ── 2. Resources: unknown resource types ──────────────────────────────────
    const resources = parsed['resources'] as Record<string, unknown> | undefined;
    if (resources) {
        for (const key of Object.keys(resources)) {
            if (!VALID_RESOURCE_TYPES.has(key)) {
                const d = diagForKey(lines, key,
                    `Unknown resource type "${key}". Valid types: ${[...VALID_RESOURCE_TYPES].join(', ')}`,
                    vscode.DiagnosticSeverity.Warning);
                if (d) { diags.push(d); }
            }
        }
    }

    // ── 3. Targets validation ─────────────────────────────────────────────────
    const productionTargets = new Set<string>();
    const targets = parsed['targets'] as Record<string, unknown> | undefined;
    if (targets) {
        for (const [targetName, targetDef] of Object.entries(targets)) {
            if (!targetDef || typeof targetDef !== 'object') { continue; }
            const target = targetDef as Record<string, unknown>;

            // 3a. Host format
            const ws = target['workspace'] as Record<string, unknown> | undefined;
            const host = ws?.['host'];
            if (typeof host === 'string' && host && !host.startsWith('https://')) {
                const d = diagForValue(lines, host,
                    `Target "${targetName}": host should start with "https://"`,
                    vscode.DiagnosticSeverity.Warning);
                if (d) { diags.push(d); }
            }

            // 3b. mode enum
            const mode = target['mode'];
            if (typeof mode === 'string' && !VALID_TARGET_MODES.has(mode)) {
                const d = diagForValue(lines, mode,
                    `Target "${targetName}": invalid mode "${mode}". Must be "development" or "production"`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }
            if (mode === 'production') {
                productionTargets.add(targetName);
            }
        }
    }

    // ── 4. Include patterns with no matches (root file only) ──────────────────
    if (isRoot) {
        const includes = parsed['include'];
        if (Array.isArray(includes)) {
            for (const pattern of includes) {
                if (typeof pattern !== 'string') { continue; }
                const normalized = pattern.replace(/^\.\//, '');
                const matched = expandGlobSimple(bundleRoot, normalized);
                if (matched.length === 0) {
                    const d = diagForValue(lines, pattern,
                        `Include pattern "${pattern}" matches no files`,
                        vscode.DiagnosticSeverity.Warning);
                    if (d) { diags.push(d); }
                }
            }
        }
    }

    // ── 5. Bundle-level permissions ───────────────────────────────────────────
    const permissions = parsed['permissions'] as unknown[] | undefined;
    if (Array.isArray(permissions)) {
        for (const perm of permissions) {
            if (!perm || typeof perm !== 'object') { continue; }
            const p = perm as Record<string, unknown>;
            const level = p['level'];
            if (typeof level === 'string' && !VALID_BUNDLE_PERMISSION_LEVELS.has(level)) {
                const d = diagForValue(lines, level,
                    `Invalid bundle permission level "${level}". Valid values: ${[...VALID_BUNDLE_PERMISSION_LEVELS].join(', ')}`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }
        }
    }

    // ── 6. Volumes: must use "grants" not "permissions" ───────────────────────
    const volumes = resources?.['volumes'] as Record<string, unknown> | undefined;
    if (volumes) {
        for (const [volName, volDef] of Object.entries(volumes)) {
            if (!volDef || typeof volDef !== 'object') { continue; }
            if ((volDef as Record<string, unknown>)['permissions']) {
                const d = diagForKey(lines, volName,
                    `Volume "${volName}": volumes use "grants" not "permissions"`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }
        }
    }

    // ── 7. Alert v2 resource validation ──────────────────────────────────────
    const alerts = resources?.['alerts'] as Record<string, unknown> | undefined;
    if (alerts) {
        for (const [alertName, alertDef] of Object.entries(alerts)) {
            if (!alertDef || typeof alertDef !== 'object') { continue; }
            const alert = alertDef as Record<string, unknown>;

            // Common mistake: "condition" instead of "evaluation"
            if (alert['condition'] && !alert['evaluation']) {
                const d = diagForKey(lines, 'condition',
                    `Alert "${alertName}": use "evaluation" not "condition" (Alert v2 API)`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }

            // Common mistake: "subscriptions" at top level instead of under evaluation.notification
            if (alert['subscriptions']) {
                const d = diagForKey(lines, 'subscriptions',
                    `Alert "${alertName}": "subscriptions" must be under "evaluation.notification.subscriptions", not at alert level`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }

            // Schedule validation
            const alertSchedule = alert['schedule'] as Record<string, unknown> | undefined;
            if (alertSchedule) {
                // Common mistake: cron_schedule → quartz_cron_schedule
                if (alertSchedule['cron_schedule'] && !alertSchedule['quartz_cron_schedule']) {
                    const d = diagForKey(lines, 'cron_schedule',
                        `Alert "${alertName}": use "quartz_cron_schedule" not "cron_schedule" in alert schedule`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }
                if (!alertSchedule['pause_status']) {
                    const d = diagForKey(lines, alertName,
                        `Alert "${alertName}": schedule.pause_status is required`,
                        vscode.DiagnosticSeverity.Warning);
                    if (d) { diags.push(d); }
                }
            }

            // evaluation.comparison_operator enum
            const evaluation = alert['evaluation'] as Record<string, unknown> | undefined;
            if (evaluation) {
                const op = evaluation['comparison_operator'];
                if (typeof op === 'string' && !VALID_ALERT_COMPARISON_OPERATORS.has(op)) {
                    const d = diagForValue(lines, op,
                        `Invalid comparison_operator "${op}". Valid values: ${[...VALID_ALERT_COMPARISON_OPERATORS].join(', ')}`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }
            }

            // Permissions on alerts use dashboard-style levels
            const alertPerms = alert['permissions'] as unknown[] | undefined;
            if (Array.isArray(alertPerms)) {
                lintResourcePermissions(lines, alertPerms, alertName, 'alert', diags);
            }
        }
    }

    // ── 8. Dashboard permissions ──────────────────────────────────────────────
    const dashboards = resources?.['dashboards'] as Record<string, unknown> | undefined;
    if (dashboards) {
        for (const [dashName, dashDef] of Object.entries(dashboards)) {
            if (!dashDef || typeof dashDef !== 'object') { continue; }
            const dash = dashDef as Record<string, unknown>;
            const dashPerms = dash['permissions'] as unknown[] | undefined;
            if (Array.isArray(dashPerms)) {
                lintResourcePermissions(lines, dashPerms, dashName, 'dashboard', diags);
            }
        }
    }

    // ── 9. Job / task validation ──────────────────────────────────────────────
    const jobs = resources?.['jobs'] as Record<string, unknown> | undefined;
    if (jobs) {
        for (const [jobName, jobDef] of Object.entries(jobs)) {
            if (!jobDef || typeof jobDef !== 'object') { continue; }
            const job = jobDef as Record<string, unknown>;

            // 9a. Missing job name
            if (!job['name']) {
                const d = diagForKey(lines, jobName,
                    `Job "${jobName}" is missing a "name" field`,
                    vscode.DiagnosticSeverity.Warning);
                if (d) { diags.push(d); }
            }

            // 9b. Mutually exclusive: schedule + continuous
            if (job['schedule'] && job['continuous']) {
                const d = diagForKey(lines, jobName,
                    `Job "${jobName}": "schedule" and "continuous" are mutually exclusive`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }

            // 9c. schedule pause_status
            const schedule = job['schedule'] as Record<string, unknown> | undefined;
            if (schedule) {
                const ps = schedule['pause_status'];
                if (typeof ps === 'string' && !VALID_PAUSE_STATUSES.has(ps)) {
                    const d = diagForValue(lines, ps,
                        `Invalid pause_status "${ps}". Must be "PAUSED" or "UNPAUSED"`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }
            }

            // 9d. trigger validation
            const trigger = job['trigger'] as Record<string, unknown> | undefined;
            if (trigger) {
                const tps = trigger['pause_status'];
                if (typeof tps === 'string' && !VALID_PAUSE_STATUSES.has(tps)) {
                    const d = diagForValue(lines, tps,
                        `Invalid trigger.pause_status "${tps}". Must be "PAUSED" or "UNPAUSED"`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }
                const periodic = trigger['periodic'] as Record<string, unknown> | undefined;
                if (periodic) {
                    const unit = periodic['unit'];
                    if (typeof unit === 'string' && !VALID_PERIODIC_UNITS.has(unit)) {
                        const d = diagForValue(lines, unit,
                            `Invalid trigger.periodic.unit "${unit}". Must be HOURS, DAYS, or WEEKS`,
                            vscode.DiagnosticSeverity.Error);
                        if (d) { diags.push(d); }
                    }
                }
                const tableUpdate = trigger['table_update'] as Record<string, unknown> | undefined;
                if (tableUpdate) {
                    const cond = tableUpdate['condition'];
                    if (typeof cond === 'string' && !VALID_TABLE_UPDATE_CONDITIONS.has(cond)) {
                        const d = diagForValue(lines, cond,
                            `Invalid trigger.table_update.condition "${cond}". Must be "ANY_UPDATED"`,
                            vscode.DiagnosticSeverity.Error);
                        if (d) { diags.push(d); }
                    }
                }
            }

            // 9e. max_concurrent_runs range
            const maxRuns = job['max_concurrent_runs'];
            if (typeof maxRuns === 'number' && (maxRuns < 0 || maxRuns > 1000)) {
                const d = diagForValue(lines, String(maxRuns),
                    `max_concurrent_runs must be between 0 and 1000 (got ${maxRuns})`,
                    vscode.DiagnosticSeverity.Error);
                if (d) { diags.push(d); }
            }

            // 9f. Job environments: spec.client required
            const environments = job['environments'] as unknown[] | undefined;
            if (Array.isArray(environments)) {
                for (const env of environments) {
                    if (!env || typeof env !== 'object') { continue; }
                    const envObj = env as Record<string, unknown>;
                    const spec = envObj['spec'] as Record<string, unknown> | undefined;
                    if (spec && !spec['client']) {
                        const envKey = envObj['environment_key'];
                        const d = diagForValue(lines, typeof envKey === 'string' ? envKey : 'spec',
                            `Environment "${envKey ?? '?'}": spec.client is required (use "4" for current serverless)`,
                            vscode.DiagnosticSeverity.Warning);
                        if (d) { diags.push(d); }
                    }
                }
            }

            // 9g. Job health rules
            const health = job['health'] as Record<string, unknown> | undefined;
            if (health) {
                const rules = health['rules'] as unknown[] | undefined;
                if (Array.isArray(rules)) {
                    for (const rule of rules) {
                        if (!rule || typeof rule !== 'object') { continue; }
                        const r = rule as Record<string, unknown>;
                        const metric = r['metric'];
                        if (typeof metric === 'string' && !VALID_HEALTH_METRICS.has(metric)) {
                            const d = diagForValue(lines, metric,
                                `Invalid health rule metric "${metric}". Valid: ${[...VALID_HEALTH_METRICS].join(', ')}`,
                                vscode.DiagnosticSeverity.Warning);
                            if (d) { diags.push(d); }
                        }
                        const op = r['op'];
                        if (typeof op === 'string' && !VALID_HEALTH_OPS.has(op)) {
                            const d = diagForValue(lines, op,
                                `Invalid health rule op "${op}". Must be "GREATER_THAN"`,
                                vscode.DiagnosticSeverity.Warning);
                            if (d) { diags.push(d); }
                        }
                    }
                }
            }

            // 9h. Job-level permissions
            const jobPerms = job['permissions'] as unknown[] | undefined;
            if (Array.isArray(jobPerms)) {
                for (const perm of jobPerms) {
                    if (!perm || typeof perm !== 'object') { continue; }
                    const p = perm as Record<string, unknown>;
                    const level = p['level'];
                    if (typeof level === 'string' && !VALID_JOB_PERMISSION_LEVELS.has(level)) {
                        const d = diagForValue(lines, level,
                            `Invalid job permission level "${level}". Valid: ${[...VALID_JOB_PERMISSION_LEVELS].join(', ')} (note: dashboards/alerts use CAN_READ/CAN_EDIT)`,
                            vscode.DiagnosticSeverity.Error);
                        if (d) { diags.push(d); }
                    }
                }
            }

            // 9i. Collect defined cluster keys and validate job_clusters
            const definedClusterKeys = new Set<string>();
            const jobClusters = job['job_clusters'] as unknown[] | undefined;
            if (Array.isArray(jobClusters)) {
                for (const jc of jobClusters) {
                    if (!jc || typeof jc !== 'object') { continue; }
                    const jcObj = jc as Record<string, unknown>;
                    const key = jcObj['job_cluster_key'];
                    if (typeof key === 'string') { definedClusterKeys.add(key); }

                    const newCluster = jcObj['new_cluster'] as Record<string, unknown> | undefined;
                    if (newCluster) {
                        lintClusterSpec(lines, newCluster, diags, productionTargets.size > 0);
                    }
                }
            }

            // 9j. Task list validation
            const taskList = job['tasks'] as unknown[] | undefined;
            if (!Array.isArray(taskList)) { continue; }

            const seenTaskKeys = new Set<string>();
            for (const task of taskList) {
                if (!task || typeof task !== 'object') { continue; }
                const t = task as Record<string, unknown>;

                // Missing task_key
                const taskKey = t['task_key'];
                if (!taskKey || (typeof taskKey === 'string' && !taskKey.trim())) {
                    diags.push(new vscode.Diagnostic(
                        lineRange(lines, jobName),
                        `Job "${jobName}": a task is missing task_key`,
                        vscode.DiagnosticSeverity.Error,
                    ));
                } else if (typeof taskKey === 'string') {
                    // Duplicate task_key
                    if (seenTaskKeys.has(taskKey)) {
                        const d = diagForValue(lines, taskKey,
                            `Job "${jobName}": duplicate task_key "${taskKey}"`,
                            vscode.DiagnosticSeverity.Error);
                        if (d) { diags.push(d); }
                    }
                    seenTaskKeys.add(taskKey);
                }

                // run_if enum
                const runIf = t['run_if'];
                if (typeof runIf === 'string' && !VALID_RUN_IF_VALUES.has(runIf)) {
                    const d = diagForValue(lines, runIf,
                        `Invalid run_if "${runIf}". Valid: ${[...VALID_RUN_IF_VALUES].join(', ')}`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }

                // Mutually exclusive: job_cluster_key + existing_cluster_id
                if (t['job_cluster_key'] && t['existing_cluster_id']) {
                    const d = diagForValue(lines, String(taskKey ?? jobName),
                        `Task "${taskKey}": "job_cluster_key" and "existing_cluster_id" are mutually exclusive`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }

                // Undefined job_cluster_key
                const clusterKey = t['job_cluster_key'];
                if (typeof clusterKey === 'string' && clusterKey &&
                    definedClusterKeys.size > 0 &&
                    !definedClusterKeys.has(clusterKey)) {
                    const d = diagForValue(lines, clusterKey,
                        `Job "${jobName}": job_cluster_key "${clusterKey}" is not defined in job_clusters`,
                        vscode.DiagnosticSeverity.Error);
                    if (d) { diags.push(d); }
                }

                // new_cluster on task
                const newCluster = t['new_cluster'] as Record<string, unknown> | undefined;
                if (newCluster) {
                    lintClusterSpec(lines, newCluster, diags, productionTargets.size > 0);
                }

                // spark_python_task — python_file must exist
                const pyTask = t['spark_python_task'] as Record<string, unknown> | undefined;
                if (pyTask) {
                    const rawPath = pyTask['python_file'];
                    if (typeof rawPath === 'string') {
                        const resolved = resolveBundlePath(fileDir, rawPath);
                        if (!fs.existsSync(resolved)) {
                            const d = diagForValue(lines, rawPath,
                                `python_file not found: ${rawPath}`,
                                vscode.DiagnosticSeverity.Error);
                            if (d) { diags.push(d); }
                        }
                    }
                    // Deprecated: jar_uri
                    if (pyTask['jar_uri']) {
                        const d = diagForKey(lines, 'jar_uri',
                            '"jar_uri" is deprecated in spark_python_task',
                            vscode.DiagnosticSeverity.Warning);
                        if (d) { diags.push(d); }
                    }
                }

                // notebook_task — notebook_path must exist (local paths only)
                const nbTask = t['notebook_task'] as Record<string, unknown> | undefined;
                if (nbTask) {
                    const rawPath = nbTask['notebook_path'];
                    if (typeof rawPath === 'string' && !rawPath.startsWith('/')) {
                        const resolved = resolveBundlePath(fileDir, rawPath);
                        if (!fs.existsSync(resolved)) {
                            const d = diagForValue(lines, rawPath,
                                `notebook_path not found: ${rawPath}`,
                                vscode.DiagnosticSeverity.Error);
                            if (d) { diags.push(d); }
                        }
                    }
                }
            }
        }
    }

    for (const d of diags) { d.source = BUNDLE_SOURCE; }
    return diags;
}

// ─── Resource permission validator ────────────────────────────────────────────

function lintResourcePermissions(
    lines: string[],
    perms: unknown[],
    resourceName: string,
    resourceType: string,
    diags: vscode.Diagnostic[],
): void {
    for (const perm of perms) {
        if (!perm || typeof perm !== 'object') { continue; }
        const p = perm as Record<string, unknown>;
        const level = p['level'];
        if (typeof level === 'string' && !VALID_RESOURCE_PERMISSION_LEVELS.has(level)) {
            const d = diagForValue(lines, level,
                `Invalid ${resourceType} permission level "${level}". Valid: ${[...VALID_RESOURCE_PERMISSION_LEVELS].join(', ')}`,
                vscode.DiagnosticSeverity.Error);
            if (d) { diags.push(d); }
        }
        // Common mistake: using CAN_VIEW on dashboards/alerts
        if (level === 'CAN_VIEW') {
            const d = diagForValue(lines, 'CAN_VIEW',
                `"CAN_VIEW" is not valid for ${resourceType}s. Did you mean "CAN_READ"?`,
                vscode.DiagnosticSeverity.Warning);
            if (d) { diags.push(d); }
        }
    }
    void resourceName; // suppress unused warning
}

// ─── Cluster spec validator ───────────────────────────────────────────────────

function lintClusterSpec(
    lines: string[],
    cluster: Record<string, unknown>,
    diags: vscode.Diagnostic[],
    hasProductionTarget: boolean,
): void {
    // data_security_mode enum
    const dsm = cluster['data_security_mode'];
    if (typeof dsm === 'string' && !VALID_DATA_SECURITY_MODES.has(dsm)) {
        const d = diagForValue(lines, dsm,
            `Invalid data_security_mode "${dsm}". Valid values: ${[...VALID_DATA_SECURITY_MODES].join(', ')}`,
            vscode.DiagnosticSeverity.Error);
        if (d) { diags.push(d); }
    }

    // data_security_mode: NONE in production
    if (dsm === 'NONE' && hasProductionTarget) {
        const d = diagForValue(lines, 'NONE',
            'data_security_mode: NONE disables access controls — not recommended for production targets',
            vscode.DiagnosticSeverity.Warning);
        if (d) { diags.push(d); }
    }

    // data_security_mode: SINGLE_USER requires single_user_name
    if (dsm === 'SINGLE_USER' && !cluster['single_user_name']) {
        const d = diagForValue(lines, 'SINGLE_USER',
            'data_security_mode: SINGLE_USER requires single_user_name to be set',
            vscode.DiagnosticSeverity.Warning);
        if (d) { diags.push(d); }
    }

    // runtime_engine enum
    const engine = cluster['runtime_engine'];
    if (typeof engine === 'string' && !VALID_RUNTIME_ENGINES.has(engine)) {
        const d = diagForValue(lines, engine,
            `Invalid runtime_engine "${engine}". Must be "PHOTON" or "STANDARD"`,
            vscode.DiagnosticSeverity.Error);
        if (d) { diags.push(d); }
    }

    // Deprecated: photon: true → use runtime_engine: PHOTON
    if (cluster['photon'] === true) {
        const d = diagForKey(lines, 'photon',
            '"photon: true" is deprecated. Use "runtime_engine: PHOTON" instead',
            vscode.DiagnosticSeverity.Warning);
        if (d) { diags.push(d); }
    }

    // spark_version format
    const sv = cluster['spark_version'];
    if (typeof sv === 'string' && sv && !SPARK_VERSION_RE.test(sv)) {
        const d = diagForValue(lines, sv,
            `spark_version "${sv}" looks invalid. Expected format: "14.3.x" or "14.3.x-scala2.12"`,
            vscode.DiagnosticSeverity.Warning);
        if (d) { diags.push(d); }
    }

    // num_workers must be non-negative integer
    const nw = cluster['num_workers'];
    if (typeof nw === 'number' && (!Number.isInteger(nw) || nw < 0)) {
        const d = diagForValue(lines, String(nw),
            `num_workers must be a non-negative integer (got ${nw})`,
            vscode.DiagnosticSeverity.Error);
        if (d) { diags.push(d); }
    }

    // autotermination_minutes range
    const atm = cluster['autotermination_minutes'];
    if (typeof atm === 'number' && (atm < 10 || atm > 10000)) {
        const d = diagForValue(lines, String(atm),
            `autotermination_minutes must be between 10 and 10000 (got ${atm})`,
            vscode.DiagnosticSeverity.Error);
        if (d) { diags.push(d); }
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a diagnostic whose range covers the first occurrence of `value` in the document. */
function diagForValue(
    lines: string[],
    value: string,
    message: string,
    severity: vscode.DiagnosticSeverity,
): vscode.Diagnostic | undefined {
    for (let i = 0; i < lines.length; i++) {
        const col = lines[i].indexOf(value);
        if (col >= 0) {
            const range = new vscode.Range(i, col, i, col + value.length);
            return new vscode.Diagnostic(range, message, severity);
        }
    }
    return undefined;
}

/**
 * Creates a diagnostic whose range covers a YAML key on the line that contains it.
 * Matches the key followed by a colon to avoid false positives in values.
 */
function diagForKey(
    lines: string[],
    key: string,
    message: string,
    severity: vscode.DiagnosticSeverity,
): vscode.Diagnostic | undefined {
    const re = new RegExp(`(^|\\s)${escapeRe(key)}\\s*:`);
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(re);
        if (m) {
            const col = lines[i].indexOf(key);
            const range = new vscode.Range(i, col, i, col + key.length);
            return new vscode.Diagnostic(range, message, severity);
        }
    }
    // Fallback: any occurrence
    return diagForValue(lines, key, message, severity);
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns a range covering the first line that contains `text`. */
function lineRange(lines: string[], text: string): vscode.Range {
    const idx = lines.findIndex(l => l.includes(text));
    const line = Math.max(0, idx);
    return new vscode.Range(line, 0, line, lines[line]?.length ?? 0);
}

function resolveBundlePath(fileDir: string, rawPath: string): string {
    const normalized = rawPath.replace(/^\.\//, '');
    return path.isAbsolute(normalized) ? normalized : path.resolve(fileDir, normalized);
}

// Minimal glob expander (mirrors bundleParser.ts — kept local to avoid circular dep)
function expandGlobSimple(baseDir: string, pattern: string): string[] {
    const parts = pattern.split('/');
    return expandParts(baseDir, parts);
}

function expandParts(dir: string, parts: string[]): string[] {
    if (parts.length === 0) { return []; }
    const [head, ...rest] = parts;
    if (head === '.') { return rest.length > 0 ? expandParts(dir, rest) : []; }
    if (head === '**') {
        if (rest.length === 0) { return allFiles(dir); }
        const r: string[] = [];
        r.push(...expandParts(dir, rest));
        for (const sub of listDirs(dir)) { r.push(...expandParts(sub, parts)); }
        return r;
    }
    if (rest.length === 0) { return matchFiles(dir, head); }
    const r: string[] = [];
    for (const sub of matchDirs(dir, head)) { r.push(...expandParts(sub, rest)); }
    return r;
}

function globRe(pat: string): RegExp {
    return new RegExp('^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
}
function listDirs(d: string): string[] {
    try { return fs.readdirSync(d).map(e => path.join(d, e)).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }); }
    catch { return []; }
}
function matchDirs(d: string, pat: string): string[] {
    const re = globRe(pat);
    try { return fs.readdirSync(d).filter(e => re.test(e)).map(e => path.join(d, e)).filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } }); }
    catch { return []; }
}
function matchFiles(d: string, pat: string): string[] {
    const re = globRe(pat);
    try { return fs.readdirSync(d).filter(e => re.test(e)).map(e => path.join(d, e)).filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }); }
    catch { return []; }
}
function allFiles(d: string): string[] {
    const r: string[] = [];
    try { for (const e of fs.readdirSync(d)) { const p = path.join(d, e); try { if (fs.statSync(p).isDirectory()) { r.push(...allFiles(p)); } else { r.push(p); } } catch { /**/ } } } catch { /**/ }
    return r;
}
