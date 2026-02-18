/**
 * Parse .databricks/config INI-format file
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface DatabricksFileConfig {
    host: string;
    token: string;
    clusterId?: string;
}

export interface DatabricksProfile {
    name: string;
    host: string;
    hasToken: boolean;
    clusterId?: string;
}

/**
 * Read and parse a .databricks/config INI file for the given profile.
 */
export function readDatabricksConfig(configPath: string, profile: string): DatabricksFileConfig | undefined {
    const resolvedPath = configPath.replace(/^~/, os.homedir());

    try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return parseIniConfig(content, profile);
    } catch {
        return undefined;
    }
}

/**
 * List all profiles found in a .databricks/config file.
 */
export function listProfiles(configPath: string): DatabricksProfile[] {
    const resolvedPath = configPath.replace(/^~/, os.homedir());

    try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        return parseAllProfiles(content);
    } catch {
        return [];
    }
}

function parseAllProfiles(content: string): DatabricksProfile[] {
    const profiles: DatabricksProfile[] = [];
    const lines = content.split('\n');
    let currentProfile: string | null = null;
    let values: Record<string, string> = {};

    const flush = () => {
        if (currentProfile && values['host']) {
            profiles.push({
                name: currentProfile,
                host: values['host'],
                hasToken: !!values['token'],
                clusterId: values['cluster_id'] || values['clusterid'] || undefined,
            });
        }
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#') || line.startsWith(';')) { continue; }

        const sectionMatch = line.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            flush();
            currentProfile = sectionMatch[1].trim();
            values = {};
            continue;
        }

        const eqIndex = line.indexOf('=');
        if (eqIndex > 0) {
            const key = line.substring(0, eqIndex).trim().toLowerCase();
            const value = line.substring(eqIndex + 1).trim();
            values[key] = value;
        }
    }

    flush();
    return profiles;
}

function parseIniConfig(content: string, targetProfile: string): DatabricksFileConfig | undefined {
    const lines = content.split('\n');
    let currentProfile: string | null = null;
    const values: Record<string, string> = {};
    let found = false;

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line || line.startsWith('#') || line.startsWith(';')) {
            continue;
        }

        // Section header: [PROFILE_NAME]
        const sectionMatch = line.match(/^\[(.+)\]$/);
        if (sectionMatch) {
            if (found) { break; } // We already parsed our target profile
            currentProfile = sectionMatch[1].trim();
            if (currentProfile === targetProfile) {
                found = true;
            }
            continue;
        }

        // Key=value pair
        if (found) {
            const eqIndex = line.indexOf('=');
            if (eqIndex > 0) {
                const key = line.substring(0, eqIndex).trim().toLowerCase();
                const value = line.substring(eqIndex + 1).trim();
                values[key] = value;
            }
        }
    }

    if (!found) { return undefined; }

    const host = values['host'] || '';
    const token = values['token'] || '';
    if (!host || !token) { return undefined; }

    return {
        host,
        token,
        clusterId: values['cluster_id'] || values['clusterid'] || undefined,
    };
}
