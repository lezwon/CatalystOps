/**
 * Tests for the dry-run nudge trigger logic (computeNudgeState).
 * Pure unit tests — no VS Code dependency.
 */

import * as assert from 'assert';
import { computeNudgeState } from '../../vscode/nudgeState';

const THRESHOLD = 3;

function opts(overrides: Partial<Parameters<typeof computeNudgeState>[0]> = {}): Parameters<typeof computeNudgeState>[0] {
    return {
        issueCount: 5,
        nudgeShown: false,
        hasUsedDryRun: false,
        currentScanCount: 0,
        threshold: THRESHOLD,
        ...overrides,
    };
}

suite('Dry Run Nudge Logic', () => {

    suite('suppression conditions', () => {
        test('should not trigger when issueCount is 0', () => {
            const { shouldShow, newScanCount } = computeNudgeState(opts({ issueCount: 0, currentScanCount: THRESHOLD - 1 }));
            assert.strictEqual(shouldShow, false);
            assert.strictEqual(newScanCount, THRESHOLD - 1, 'scan count must not increment when issueCount is 0');
        });

        test('should not trigger when nudge was already shown', () => {
            const { shouldShow } = computeNudgeState(opts({ nudgeShown: true, currentScanCount: THRESHOLD - 1 }));
            assert.strictEqual(shouldShow, false);
        });

        test('should not trigger when user has already used dry run', () => {
            const { shouldShow } = computeNudgeState(opts({ hasUsedDryRun: true, currentScanCount: THRESHOLD - 1 }));
            assert.strictEqual(shouldShow, false);
        });
    });

    suite('scan counter progression', () => {
        test('should increment scan count on each eligible scan', () => {
            let scanCount = 0;
            for (let scan = 1; scan < THRESHOLD; scan++) {
                const result = computeNudgeState(opts({ currentScanCount: scanCount }));
                assert.strictEqual(result.shouldShow, false, `scan ${scan} should not trigger yet`);
                assert.strictEqual(result.newScanCount, scan, `scan count after scan ${scan} should be ${scan}`);
                scanCount = result.newScanCount;
            }
        });

        test('should trigger exactly at the threshold', () => {
            const { shouldShow, newScanCount } = computeNudgeState(opts({ currentScanCount: THRESHOLD - 1 }));
            assert.strictEqual(shouldShow, true, 'should trigger at threshold');
            assert.strictEqual(newScanCount, THRESHOLD);
        });

        test('should not trigger one scan before the threshold', () => {
            const { shouldShow } = computeNudgeState(opts({ currentScanCount: THRESHOLD - 2 }));
            assert.strictEqual(shouldShow, false);
        });

        test('should not re-trigger after nudgeShown is set', () => {
            // Simulate the state after nudge was shown (nudgeShown=true, count>=threshold)
            const { shouldShow } = computeNudgeState(opts({ nudgeShown: true, currentScanCount: THRESHOLD }));
            assert.strictEqual(shouldShow, false);
        });
    });

    suite('plural/singular issue message parity', () => {
        test('count is correct for 1 issue', () => {
            const { newScanCount } = computeNudgeState(opts({ issueCount: 1 }));
            assert.strictEqual(newScanCount, 1);
        });

        test('count is correct for many issues', () => {
            const { newScanCount } = computeNudgeState(opts({ issueCount: 42 }));
            assert.strictEqual(newScanCount, 1);
        });
    });
});
