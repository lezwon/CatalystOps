/**
 * Test runner for CatalystOps extension tests
 */

import * as path from 'path';
const Mocha = require('mocha') as typeof import('mocha');
import * as fs from 'fs';

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'bdd', color: true, timeout: 10000 });
    const testsRoot = path.resolve(__dirname, '.');

    return new Promise((resolve, reject) => {
        const testFiles = fs
            .readdirSync(testsRoot)
            .filter((f: string) => f.endsWith('.test.js'));

        for (const file of testFiles) {
            mocha.addFile(path.resolve(testsRoot, file));
        }

        try {
            mocha.run((failures: number) => {
                if (failures > 0) {
                    reject(new Error(`${failures} tests failed.`));
                } else {
                    resolve();
                }
            });
        } catch (err) {
            reject(err);
        }
    });
}
