/**
 * Databricks Asset Bundle (DAB) parser.
 *
 * Detects databricks.yml in the workspace and extracts:
 *  - Python tasks (spark_python_task) with resolved file paths
 *  - Target workspace hosts for connection setup
 *
 * Handles the `include:` directive — glob patterns that pull in
 * additional YAML files (e.g. `include: [resources/jobs/*.yml]`).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as yaml from 'js-yaml';
import { logDebug } from '../logger';

export interface BundleTask {
    jobName: string;
    taskKey: string;
    pythonFile: string;   // absolute path resolved from the file it was declared in
    taskType: 'spark_python_task' | 'notebook_task';
    clusterSpec?: { nodeType?: string; numWorkers?: number };
}

export interface BundleTarget {
    name: string;
    host: string;
}

export interface BundleConfig {
    name: string;
    bundlePath: string;   // absolute path of databricks.yml
    includedFiles: string[]; // all YAML files read (for watcher registration)
    tasks: BundleTask[];
    targets: BundleTarget[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/** Searches workspace root folders for databricks.yml or databricks.yaml. */
export function findBundleFile(folders: readonly vscode.WorkspaceFolder[]): string | undefined {
    for (const folder of folders) {
        for (const name of ['databricks.yml', 'databricks.yaml']) {
            const candidate = path.join(folder.uri.fsPath, name);
            if (fs.existsSync(candidate)) { return candidate; }
        }
    }
    return undefined;
}

/** Parses a databricks.yml file and returns a BundleConfig, or undefined on error. */
export function parseBundleFile(filePath: string): BundleConfig | undefined {
    const doc = loadYaml(filePath);
    if (!doc) {
        logDebug(`[Bundle] Failed to parse ${filePath}`);
        return undefined;
    }

    const bundleRoot = path.dirname(filePath);
    const visited = new Set<string>([path.resolve(filePath)]);

    // Bundle name from root file only
    const name = (doc['bundle'] as Record<string, unknown> | undefined)?.['name'];
    const bundleName = typeof name === 'string' ? name : path.basename(bundleRoot);

    const tasks: BundleTask[] = [];
    const targets: BundleTarget[] = [];

    // Process root doc
    extractTasks(doc, bundleRoot, tasks);
    extractTargets(doc, targets);

    // Resolve included files
    const includePatterns = doc['include'];
    const includedFiles: string[] = [];

    if (Array.isArray(includePatterns)) {
        logDebug(`[Bundle] include patterns: ${JSON.stringify(includePatterns)}`);
        for (const pattern of includePatterns) {
            if (typeof pattern !== 'string') { continue; }
            // Normalize: strip leading './' — the bundle root is always the base
            const normalizedPattern = pattern.replace(/^\.\//, '');
            const matched = expandGlob(bundleRoot, normalizedPattern);
            logDebug(`[Bundle] pattern "${pattern}" → ${matched.length} file(s): ${matched.join(', ')}`);

            for (const absPath of matched) {
                if (visited.has(absPath)) { continue; }
                visited.add(absPath);
                includedFiles.push(absPath);

                const subDoc = loadYaml(absPath);
                if (!subDoc) {
                    logDebug(`[Bundle] Failed to parse included file: ${absPath}`);
                    continue;
                }

                // Paths in included files are resolved relative to that file's directory.
                // The CLI template places resource files in resources/ and uses ../src/...
                // which only makes sense when resolved from the resource file's location.
                extractTasks(subDoc, path.dirname(absPath), tasks);
                extractTargets(subDoc, targets);
            }
        }
    }

    logDebug(`[Bundle] "${bundleName}" — ${tasks.length} Python task(s), ${targets.length} target(s), ${includedFiles.length} included file(s)`);
    return { name: bundleName, bundlePath: filePath, includedFiles, tasks, targets };
}

// ─── YAML loading ─────────────────────────────────────────────────────────────

function loadYaml(filePath: string): Record<string, unknown> | undefined {
    let raw: string;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch {
        return undefined;
    }
    let doc: unknown;
    try {
        doc = yaml.load(raw);
    } catch {
        return undefined;
    }
    return (doc && typeof doc === 'object') ? doc as Record<string, unknown> : undefined;
}

// ─── Resource extraction ──────────────────────────────────────────────────────

/**
 * @param doc     Parsed YAML document
 * @param fileDir Directory of the file being parsed — used for relative path resolution.
 *                The Databricks CLI template generates paths like `../src/task.py` in
 *                resource files under `resources/`, so they must resolve from that file's
 *                directory, not the bundle root.
 * @param out     Output array to push tasks into
 */
function extractTasks(
    doc: Record<string, unknown>,
    fileDir: string,
    out: BundleTask[],
): void {
    const resources = doc['resources'] as Record<string, unknown> | undefined;
    const jobs = resources?.['jobs'] as Record<string, unknown> | undefined;
    if (!jobs) { return; }

    for (const [jobName, jobDef] of Object.entries(jobs)) {
        if (!jobDef || typeof jobDef !== 'object') { continue; }
        const job = jobDef as Record<string, unknown>;

        // Build cluster-key → spec map from job_clusters
        const clusterSpecMap = new Map<string, { nodeType?: string; numWorkers?: number }>();
        const jobClusters = job['job_clusters'] as unknown[] | undefined;
        if (Array.isArray(jobClusters)) {
            for (const jc of jobClusters) {
                if (!jc || typeof jc !== 'object') { continue; }
                const jcObj = jc as Record<string, unknown>;
                const key = typeof jcObj['job_cluster_key'] === 'string' ? jcObj['job_cluster_key'] : undefined;
                const newCluster = jcObj['new_cluster'] as Record<string, unknown> | undefined;
                if (key && newCluster) {
                    clusterSpecMap.set(key, {
                        nodeType: typeof newCluster['node_type_id'] === 'string' ? newCluster['node_type_id'] : undefined,
                        numWorkers: typeof newCluster['num_workers'] === 'number' ? newCluster['num_workers'] : undefined,
                    });
                }
            }
        }

        const taskList = job['tasks'] as unknown[] | undefined;
        if (!Array.isArray(taskList)) { continue; }

        for (const task of taskList) {
            if (!task || typeof task !== 'object') { continue; }
            const t = task as Record<string, unknown>;
            const taskKey = typeof t['task_key'] === 'string' ? t['task_key'] : 'unknown';
            const clusterKey = typeof t['job_cluster_key'] === 'string' ? t['job_cluster_key'] : undefined;

            // spark_python_task — direct Python script
            const pythonTask = t['spark_python_task'] as Record<string, unknown> | undefined;
            if (pythonTask) {
                const raw = pythonTask['python_file'];
                if (typeof raw === 'string') {
                    const pythonFile = resolvePath(fileDir, raw);
                    logDebug(`[Bundle] spark_python_task "${jobName}/${taskKey}" → ${pythonFile}`);
                    out.push({ jobName, taskKey, pythonFile, taskType: 'spark_python_task',
                        clusterSpec: clusterKey ? clusterSpecMap.get(clusterKey) : undefined });
                }
                continue;
            }

            // notebook_task — Python notebook (.py Databricks format or .ipynb)
            const notebookTask = t['notebook_task'] as Record<string, unknown> | undefined;
            if (notebookTask) {
                const raw = notebookTask['notebook_path'];
                if (typeof raw === 'string') {
                    // notebook_path may be a workspace path (/Workspace/...) or a relative local path
                    if (!raw.startsWith('/')) {
                        const pythonFile = resolvePath(fileDir, raw);
                        logDebug(`[Bundle] notebook_task "${jobName}/${taskKey}" → ${pythonFile}`);
                        out.push({ jobName, taskKey, pythonFile, taskType: 'notebook_task',
                            clusterSpec: clusterKey ? clusterSpecMap.get(clusterKey) : undefined });
                    }
                }
            }
        }
    }
}

/** Resolves a potentially relative path against a base directory, stripping leading './' */
function resolvePath(baseDir: string, rawPath: string): string {
    const normalized = rawPath.replace(/^\.\//, '');
    return path.isAbsolute(normalized) ? normalized : path.resolve(baseDir, normalized);
}

function extractTargets(doc: Record<string, unknown>, out: BundleTarget[]): void {
    const targetsDef = doc['targets'] as Record<string, unknown> | undefined;
    if (!targetsDef) { return; }
    for (const [targetName, targetDef] of Object.entries(targetsDef)) {
        if (!targetDef || typeof targetDef !== 'object') { continue; }
        const workspace = (targetDef as Record<string, unknown>)['workspace'] as Record<string, unknown> | undefined;
        const host = workspace?.['host'];
        if (typeof host === 'string' && host) {
            if (!out.some(t => t.name === targetName)) {
                out.push({ name: targetName, host });
            }
        }
    }
}

// ─── Minimal glob expander ────────────────────────────────────────────────────
// Supports:  *.yml  |  **/*.yml  |  dir/*.yml  |  dir/**/*.yml  |  exact.yml
// Note: leading './' must be stripped before calling this function.

function expandGlob(baseDir: string, pattern: string): string[] {
    const parts = pattern.split('/');
    return expandParts(baseDir, parts);
}

function expandParts(dir: string, parts: string[]): string[] {
    if (parts.length === 0) { return []; }

    const [head, ...rest] = parts;

    // Current-directory no-op: '.' → continue with same dir
    if (head === '.') {
        return rest.length > 0 ? expandParts(dir, rest) : [];
    }

    // Double-star: match any depth (zero or more directory levels)
    if (head === '**') {
        if (rest.length === 0) {
            // bare '**' at the end — match all files recursively
            return allFilesRecursive(dir);
        }
        const results: string[] = [];
        // Zero dirs consumed: match rest directly from current dir
        results.push(...expandParts(dir, rest));
        // One or more dirs consumed: recurse into each subdir
        for (const sub of subdirs(dir)) {
            results.push(...expandParts(sub, parts)); // keep '**'
        }
        return results;
    }

    // Last segment: match files
    if (rest.length === 0) {
        return matchFiles(dir, head);
    }

    // Intermediate segment: match subdirectories
    const results: string[] = [];
    for (const sub of matchDirs(dir, head)) {
        results.push(...expandParts(sub, rest));
    }
    return results;
}

function matchFiles(dir: string, pattern: string): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    const re = globToRegex(pattern);
    return entries
        .filter(e => re.test(e))
        .map(e => path.join(dir, e))
        .filter(p => { try { return fs.statSync(p).isFile(); } catch { return false; } });
}

function matchDirs(dir: string, pattern: string): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    const re = globToRegex(pattern);
    return entries
        .filter(e => re.test(e))
        .map(e => path.join(dir, e))
        .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function subdirs(dir: string): string[] {
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    return entries
        .map(e => path.join(dir, e))
        .filter(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } });
}

function allFilesRecursive(dir: string): string[] {
    const results: string[] = [];
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return []; }
    for (const e of entries) {
        const full = path.join(dir, e);
        try {
            if (fs.statSync(full).isDirectory()) {
                results.push(...allFilesRecursive(full));
            } else {
                results.push(full);
            }
        } catch { /* skip */ }
    }
    return results;
}

/** Converts a glob segment (only * supported) to a RegExp. */
function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars
        .replace(/\*/g, '[^/]*');              // * → anything except /
    return new RegExp(`^${escaped}$`);
}
