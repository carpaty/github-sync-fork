import * as assert from 'assert';
import { getAutoSyncPauseInfo, getPromptRateLimitPauseInfo, getUnifiedPauseInfo, isBranchEligibleForAutoSync, isPromptThrottled } from '../autoSyncPolicy';

suite('AutoSyncPolicy', () => {
    test('prompt mode allows non-listed branch when not excluded', () => {
        const eligible = isBranchEligibleForAutoSync('prompt', 'feature/foo', ['main', 'master']);
        assert.strictEqual(eligible, true);
    });

    test('prompt mode excludes explicit !branch', () => {
        const eligible = isBranchEligibleForAutoSync('prompt', 'dev', ['main', 'master', '!dev']);
        assert.strictEqual(eligible, false);
    });

    test('prompt mode excludes wildcard !pattern branch', () => {
        const eligible = isBranchEligibleForAutoSync('prompt', 'release/v2', ['main', 'master', '!release/*']);
        assert.strictEqual(eligible, false);
    });

    test('always mode requires include pattern', () => {
        const eligible = isBranchEligibleForAutoSync('always', 'feature/foo', ['main', 'master']);
        assert.strictEqual(eligible, false);
    });

    test('exclude pattern wins over include pattern', () => {
        const eligible = isBranchEligibleForAutoSync('always', 'dev', ['dev', '!dev']);
        assert.strictEqual(eligible, false);
    });

    test('pause info returns cooldown when cooldown active', () => {
        const now = 1_000_000;
        const pauseInfo = getAutoSyncPauseInfo(now, now - 30_000, undefined, 60_000);
        assert.ok(pauseInfo);
        assert.strictEqual(pauseInfo?.reason, 'cooldown');
        assert.strictEqual(pauseInfo?.nextEligibleAt, now + 30_000);
    });

    test('pause info returns snooze when snooze is later than cooldown', () => {
        const now = 1_000_000;
        const pauseInfo = getAutoSyncPauseInfo(now, now - 10_000, now + 120_000, 60_000);
        assert.ok(pauseInfo);
        assert.strictEqual(pauseInfo?.reason, 'snooze');
        assert.strictEqual(pauseInfo?.nextEligibleAt, now + 120_000);
    });

    test('pause info returns undefined when neither cooldown nor snooze active', () => {
        const now = 1_000_000;
        const pauseInfo = getAutoSyncPauseInfo(now, now - 120_000, now - 1, 60_000);
        assert.strictEqual(pauseInfo, undefined);
    });

    test('prompt throttling blocks recent prompt', () => {
        const now = 1_000_000;
        const throttled = isPromptThrottled(now, now - 30_000, 60_000);
        assert.strictEqual(throttled, true);
    });

    test('prompt throttling allows after interval', () => {
        const now = 1_000_000;
        const throttled = isPromptThrottled(now, now - 120_000, 60_000);
        assert.strictEqual(throttled, false);
    });

    test('prompt rate-limit pause info uses max of status and prompt windows', () => {
        const now = 1_000_000;
        const pauseInfo = getPromptRateLimitPauseInfo(now, now - 30_000, 300_000, 120_000);
        assert.ok(pauseInfo);
        assert.strictEqual(pauseInfo?.reason, 'prompt-rate-limit');
        assert.strictEqual(pauseInfo?.nextEligibleAt, now + 270_000);
    });

    test('unified pause info returns prompt-rate-limit when later than cooldown', () => {
        const now = 1_000_000;
        const pauseInfo = getUnifiedPauseInfo(
            now,
            'prompt',
            now - 10_000,
            undefined,
            60_000,
            now - 10_000,
            300_000,
            120_000
        );
        assert.ok(pauseInfo);
        assert.strictEqual(pauseInfo?.reason, 'prompt-rate-limit');
        assert.strictEqual(pauseInfo?.nextEligibleAt, now + 290_000);
    });

    test('unified pause info ignores prompt-rate-limit in always mode', () => {
        const now = 1_000_000;
        const pauseInfo = getUnifiedPauseInfo(
            now,
            'always',
            now - 10_000,
            undefined,
            60_000,
            now - 10_000,
            300_000,
            120_000
        );
        assert.ok(pauseInfo);
        assert.strictEqual(pauseInfo?.reason, 'cooldown');
        assert.strictEqual(pauseInfo?.nextEligibleAt, now + 50_000);
    });
});
