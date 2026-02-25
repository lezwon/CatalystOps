/**
 * Pure nudge-trigger logic — no VS Code dependency so it can be unit tested.
 */

export interface NudgeState {
    /** Whether the nudge toast should be shown after this scan. */
    shouldShow: boolean;
    /** Updated scan count to persist in globalState. */
    newScanCount: number;
}

export interface NudgeOpts {
    issueCount: number;
    nudgeShown: boolean;
    hasUsedDryRun: boolean;
    currentScanCount: number;
    threshold: number;
}

/**
 * Given the current globalState flags and the latest issue count, decide
 * whether to show the dry-run nudge and return the updated scan counter.
 *
 * Rules:
 *  - Skip entirely when issueCount is 0, nudge was already shown, or the
 *    user has already run a dry run.
 *  - Otherwise increment the counter; show the nudge once the counter
 *    reaches `threshold`.
 */
export function computeNudgeState(opts: NudgeOpts): NudgeState {
    const { issueCount, nudgeShown, hasUsedDryRun, currentScanCount, threshold } = opts;

    if (issueCount === 0 || nudgeShown || hasUsedDryRun) {
        return { shouldShow: false, newScanCount: currentScanCount };
    }

    const newScanCount = currentScanCount + 1;
    return { shouldShow: newScanCount >= threshold, newScanCount };
}
