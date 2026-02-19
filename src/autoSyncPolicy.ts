export type AutoSyncMode = 'off' | 'prompt' | 'always';

export interface AutoSyncPauseInfo {
    nextEligibleAt: number;
    reason: 'cooldown' | 'snooze';
}

export interface AutoSyncUnifiedPauseInfo {
    nextEligibleAt: number;
    reason: 'cooldown' | 'snooze' | 'prompt-rate-limit';
}

function globToRegExp(pattern: string): RegExp {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = `^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
    return new RegExp(regex);
}

export function isBranchExcluded(branch: string, patterns: string[]): boolean {
    return patterns
        .filter(pattern => pattern.startsWith('!') && pattern.length > 1)
        .some(pattern => globToRegExp(pattern.slice(1)).test(branch));
}

export function isBranchIncluded(branch: string, patterns: string[]): boolean {
    return patterns
        .filter(pattern => !pattern.startsWith('!'))
        .some(pattern => globToRegExp(pattern).test(branch));
}

export function isBranchEligibleForAutoSync(mode: AutoSyncMode, branch: string, patterns: string[]): boolean {
    if (mode === 'off') { return false; }
    if (isBranchExcluded(branch, patterns)) { return false; }
    if (mode === 'always') { return isBranchIncluded(branch, patterns); }
    return true;
}

export function getAutoSyncPauseInfo(
    now: number,
    lastActionAt: number | undefined,
    snoozedUntil: number | undefined,
    cooldownMs: number
): AutoSyncPauseInfo | undefined {
    const cooldownUntil = cooldownMs > 0 && lastActionAt ? lastActionAt + cooldownMs : 0;
    const snoozeUntil = snoozedUntil ?? 0;
    const nextEligibleAt = Math.max(cooldownUntil, snoozeUntil);
    if (nextEligibleAt <= now) { return undefined; }
    return { nextEligibleAt, reason: snoozeUntil >= cooldownUntil ? 'snooze' : 'cooldown' };
}

export function isPromptThrottled(now: number, lastPromptAt: number | undefined, minIntervalMs: number): boolean {
    if (!lastPromptAt) { return false; }
    return now - lastPromptAt < minIntervalMs;
}

export function getPromptRateLimitPauseInfo(
    now: number,
    lastPromptAt: number | undefined,
    statusTriggerMinIntervalMs: number,
    promptRepeatMinIntervalMs: number
): AutoSyncUnifiedPauseInfo | undefined {
    if (!lastPromptAt) { return undefined; }
    const statusEligibleAt = lastPromptAt + statusTriggerMinIntervalMs;
    const promptEligibleAt = lastPromptAt + promptRepeatMinIntervalMs;
    const nextEligibleAt = Math.max(statusEligibleAt, promptEligibleAt);
    if (nextEligibleAt <= now) { return undefined; }
    return { nextEligibleAt, reason: 'prompt-rate-limit' };
}

export function getUnifiedPauseInfo(
    now: number,
    mode: AutoSyncMode,
    lastActionAt: number | undefined,
    snoozedUntil: number | undefined,
    cooldownMs: number,
    lastPromptAt: number | undefined,
    statusTriggerMinIntervalMs: number,
    promptRepeatMinIntervalMs: number
): AutoSyncUnifiedPauseInfo | undefined {
    const basePause = getAutoSyncPauseInfo(now, lastActionAt, snoozedUntil, cooldownMs);
    const promptPause = mode === 'prompt'
        ? getPromptRateLimitPauseInfo(now, lastPromptAt, statusTriggerMinIntervalMs, promptRepeatMinIntervalMs)
        : undefined;

    if (!basePause) { return promptPause; }
    if (!promptPause) { return basePause; }
    return promptPause.nextEligibleAt >= basePause.nextEligibleAt ? promptPause : basePause;
}
