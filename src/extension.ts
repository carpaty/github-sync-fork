import * as vscode from 'vscode';
import { Credentials } from "./cred";
import { Repositories } from "./repo";
import { AutoSyncMode, getUnifiedPauseInfo, isBranchEligibleForAutoSync, isPromptThrottled } from './autoSyncPolicy';

export function activate(context: vscode.ExtensionContext) {
	const channel = vscode.window.createOutputChannel('GitHub Sync Fork');
	context.subscriptions.push(channel);

	function debugLog(msg: string) {
		if (vscode.workspace.getConfiguration('github-sync-fork').get<boolean>('debug')) {
			channel.appendLine(`[${new Date().toISOString()}] ${msg}`);
			channel.show(true);
		}
	}

	const credentials = new Credentials(context);
	const repositories = new Repositories(debugLog);

	// Status bar: shows how many commits the fork is behind upstream.
	// Clicking triggers a sync.
	const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	statusBar.command = 'github-sync-fork.syncBranch';
	statusBar.tooltip = 'Commits behind upstream — click to sync';
	context.subscriptions.push(statusBar);

	let updateTimer: NodeJS.Timeout | undefined;
	const autoSyncTimersByRepo = new Map<string, NodeJS.Timeout>();
	const autoSyncLastActionByBranch = new Map<string, number>();
	const autoSyncSnoozedUntilByBranch = new Map<string, number>();
	const autoSyncInProgress = new Set<string>();
	const autoSyncPromptOpenByBranch = new Set<string>();
	const autoSyncLastPromptAtByBranch = new Map<string, number>();

	interface AutoSyncConfig {
		mode: AutoSyncMode;
		branches: string[];
		cooldownMs: number;
	}

	const STATUS_TRIGGER_MIN_INTERVAL_MS = 5 * 60_000;
	const PROMPT_REPEAT_MIN_INTERVAL_MS = 2 * 60_000;

	function getAutoSyncConfig(): AutoSyncConfig {
		const config = vscode.workspace.getConfiguration('github-sync-fork');
		const rawMode = config.get<string>('autoSyncOnPull', 'off');
		const mode: AutoSyncMode = rawMode === 'prompt' || rawMode === 'always' ? rawMode : 'off';
		const rawBranches = config.get<string[]>('autoSyncBranches', ['main', 'master']) ?? ['main', 'master'];
		const branches = rawBranches.map(s => s.trim()).filter(Boolean);
		const cooldownMinutes = Math.max(0, config.get<number>('autoSyncCooldownMinutes', 30) ?? 30);
		return { mode, branches, cooldownMs: cooldownMinutes * 60_000 };
	}

	function getBranchUnifiedPauseInfo(
		mode: AutoSyncMode,
		repoKey: string,
		branch: string,
		cooldownMs: number
	) {
		const branchKey = `${repoKey}::${branch}`;
		return getUnifiedPauseInfo(
			Date.now(),
			mode,
			autoSyncLastActionByBranch.get(branchKey),
			autoSyncSnoozedUntilByBranch.get(branchKey),
			cooldownMs,
			autoSyncLastPromptAtByBranch.get(branchKey),
			STATUS_TRIGGER_MIN_INTERVAL_MS,
			PROMPT_REPEAT_MIN_INTERVAL_MS
		);
	}

	async function updateAutoSyncBranches(updater: (current: string[]) => string[]): Promise<string[]> {
		const config = vscode.workspace.getConfiguration('github-sync-fork');
		const current = config.get<string[]>('autoSyncBranches', ['main', 'master']) ?? [];
		const updated = updater(current);
		if (JSON.stringify(current) === JSON.stringify(updated)) { return updated; }

		const tryUpdate = async (target: vscode.ConfigurationTarget) => {
			await config.update('autoSyncBranches', updated, target);
			const refreshed = vscode.workspace.getConfiguration('github-sync-fork').get<string[]>('autoSyncBranches', ['main', 'master']) ?? [];
			return refreshed;
		};

		// Prefer workspace setting when available, fallback to global to ensure the
		// change is persisted and visible in user settings if workspace update fails.
		if (vscode.workspace.workspaceFolders?.length) {
			try {
				const refreshed = await tryUpdate(vscode.ConfigurationTarget.Workspace);
				if (JSON.stringify(refreshed) === JSON.stringify(updated)) { return refreshed; }
			} catch {
				// fallback below
			}
		}

		return tryUpdate(vscode.ConfigurationTarget.Global);
	}

	async function ensureBranchInAutoSyncPatterns(branch: string): Promise<void> {
		await updateAutoSyncBranches((current) => {
			if (current.includes(branch) && !current.includes(`!${branch}`)) { return current; }
			const withoutExclude = current.filter(pattern => pattern !== `!${branch}`);
			return withoutExclude.includes(branch) ? withoutExclude : [...withoutExclude, branch];
		});
	}

	async function ensureBranchExcludedFromAutoSyncPatterns(branch: string): Promise<void> {
		const excludePattern = `!${branch}`;
		const updated = await updateAutoSyncBranches((current) => {
			if (current.includes(excludePattern)) { return current; }
			const withoutInclude = current.filter(pattern => pattern !== branch);
			return [...withoutInclude, excludePattern];
		});
		if (!updated.includes(excludePattern)) {
			throw new Error(`Could not persist '${excludePattern}' in autoSyncBranches.`);
		}
	}

	async function updateStatusBar() {
		const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!uri) { statusBar.hide(); return; }

		const repoKey = uri.toString();
		const branch = repositories.getCurrentBranch(uri);
		const autoSyncConfig = getAutoSyncConfig();
		const branchAutoSyncEnabled = !!branch && isBranchEligibleForAutoSync(autoSyncConfig.mode, branch, autoSyncConfig.branches);
		const pauseInfo = branch ? getBranchUnifiedPauseInfo(autoSyncConfig.mode, repoKey, branch, autoSyncConfig.cooldownMs) : undefined;

		statusBar.text = '$(sync~spin) Fork';
		statusBar.tooltip = 'Checking fork sync status...';
		statusBar.show();

		const behind = await repositories.getForkBehindCount(credentials, uri);
		debugLog(`updateStatusBar: getForkBehindCount returned ${behind}`);
		if (behind === undefined) { debugLog('updateStatusBar: hiding status bar (undefined)'); statusBar.hide(); return; }

		if (behind === 0) {
			statusBar.text = '$(check) Fork: up to date';
			statusBar.tooltip = 'Fork is up to date with upstream.';
			debugLog(`updateStatusBar: showing "${statusBar.text}"`);
			statusBar.show();
			return;
		}

		// Reliability: ensure prompt/auto-sync checks also run when status polling
		// confirms the fork is behind, not only on git state change events.
		// Guard with per-branch rate limiting to avoid frequent prompt retries.
		if (branch && isBranchEligibleForAutoSync(autoSyncConfig.mode, branch, autoSyncConfig.branches)) {
			const branchKey = `${repoKey}::${branch}`;
			const pauseInfoForPrompt = getBranchUnifiedPauseInfo(autoSyncConfig.mode, repoKey, branch, autoSyncConfig.cooldownMs);
			const recentlyPrompted = isPromptThrottled(Date.now(), autoSyncLastPromptAtByBranch.get(branchKey), STATUS_TRIGGER_MIN_INTERVAL_MS);
			if (!pauseInfoForPrompt && !autoSyncInProgress.has(branchKey) && !recentlyPrompted && !autoSyncPromptOpenByBranch.has(branchKey)) {
				scheduleAutoSyncCheck(uri);
			}
		}

		if (branchAutoSyncEnabled && pauseInfo) {
			const minutesLeft = Math.max(1, Math.ceil((pauseInfo.nextEligibleAt - Date.now()) / 60000));
			statusBar.text = '$(clock) Fork: auto-sync paused';
			const reasonText = pauseInfo.reason === 'snooze'
				? 'snoozed'
				: pauseInfo.reason === 'prompt-rate-limit'
					? 'prompt rate-limited'
					: 'cooldown active';
			statusBar.tooltip = `Fork is ${behind} commit(s) behind on '${branch}'. Auto-sync ${reasonText} (${minutesLeft} min left, next at ${new Date(pauseInfo.nextEligibleAt).toLocaleTimeString()}). Pause time is calculated from cooldown, snooze, and prompt rate-limit windows.`;
			debugLog(`updateStatusBar: showing "${statusBar.text}"`);
			statusBar.show();
			return;
		}

		statusBar.text = `$(sync) Fork: ${behind} behind`;
		if (branchAutoSyncEnabled) {
			statusBar.tooltip = `Fork is ${behind} commit(s) behind on '${branch}'. Auto-sync is enabled (${autoSyncConfig.mode}).`;
		} else {
			statusBar.tooltip = `Fork is ${behind} commit(s) behind upstream.`;
		}
		debugLog(`updateStatusBar: showing "${statusBar.text}"`);
		statusBar.show();
	}

	function scheduleStatusBarUpdate() {
		if (updateTimer) { clearTimeout(updateTimer); }
		updateTimer = setTimeout(updateStatusBar, 2000);
	}

	function scheduleAutoSyncCheck(uri?: vscode.Uri) {
		const resolvedUri = uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!resolvedUri) { return; }

		const key = resolvedUri.toString();
		const existing = autoSyncTimersByRepo.get(key);
		if (existing) { clearTimeout(existing); }

		autoSyncTimersByRepo.set(key, setTimeout(async () => {
			autoSyncTimersByRepo.delete(key);

			const { mode, branches, cooldownMs } = getAutoSyncConfig();
			if (mode === 'off') { return; }

			const currentBranch = repositories.getCurrentBranch(resolvedUri);
			if (!currentBranch) { return; }
			if (!isBranchEligibleForAutoSync(mode, currentBranch, branches)) { return; }

			const branchKey = `${key}::${currentBranch}`;
			const pauseInfo = getBranchUnifiedPauseInfo(mode, key, currentBranch, cooldownMs);
			if (pauseInfo) { return; }
			if (autoSyncInProgress.has(branchKey)) { return; }
			if (autoSyncPromptOpenByBranch.has(branchKey)) { return; }

			const recentlyPrompted = isPromptThrottled(Date.now(), autoSyncLastPromptAtByBranch.get(branchKey), PROMPT_REPEAT_MIN_INTERVAL_MS);
			if (mode === 'prompt' && recentlyPrompted) { return; }

			const behind = await repositories.getForkBehindCount(credentials, resolvedUri);
			debugLog(`autoSync: mode=${mode} branch=${currentBranch} behind=${behind}`);
			if (!behind || behind <= 0) { return; }

			if (mode === 'prompt') {
				const syncBtn = 'Sync';
				const snoozeBtn = 'Snooze 30m';
				const alwaysBtn = 'Always';
				const neverBtn = 'Never';
				autoSyncPromptOpenByBranch.add(branchKey);
				autoSyncLastPromptAtByBranch.set(branchKey, Date.now());
				let selection: string | undefined;
				try {
					selection = await vscode.window.showInformationMessage(
						`Fork branch '${currentBranch}' is ${behind} commit(s) behind upstream. Choose 'Always' to include this branch in auto-sync, or 'Never' to add '!${currentBranch}' and disable prompts/sync for it.`,
						syncBtn,
						snoozeBtn,
						alwaysBtn,
						neverBtn
					);
				} finally {
					autoSyncPromptOpenByBranch.delete(branchKey);
				}

				if (!selection) {
					// Treat dismiss as "not now" and apply cooldown.
					autoSyncLastActionByBranch.set(branchKey, Date.now());
					scheduleStatusBarUpdate();
					return;
				}

				if (selection === snoozeBtn) {
					autoSyncSnoozedUntilByBranch.set(branchKey, Date.now() + 30 * 60_000);
					autoSyncLastActionByBranch.set(branchKey, Date.now());
					scheduleStatusBarUpdate();
					return;
				}

				if (selection === alwaysBtn) {
					try {
						await ensureBranchInAutoSyncPatterns(currentBranch);
						vscode.window.showInformationMessage(`Added '${currentBranch}' to auto-sync branches.`);
					} catch (err: any) {
						vscode.window.showWarningMessage(`Could not update auto-sync branches: ${err?.message ?? 'Unknown error'}`);
						return;
					}
				}

				if (selection === neverBtn) {
					try {
						await ensureBranchExcludedFromAutoSyncPatterns(currentBranch);
						autoSyncSnoozedUntilByBranch.delete(branchKey);
						autoSyncLastActionByBranch.set(branchKey, Date.now());
						vscode.window.showInformationMessage(`Added '!${currentBranch}' to auto-sync branches.`);
						scheduleStatusBarUpdate();
					} catch (err: any) {
						vscode.window.showWarningMessage(`Could not update auto-sync branches: ${err?.message ?? 'Unknown error'}`);
					}
					return;
				}

				if (selection !== syncBtn && selection !== alwaysBtn) { return; }
			}

			autoSyncSnoozedUntilByBranch.delete(branchKey);
			autoSyncLastActionByBranch.set(branchKey, Date.now());
			scheduleStatusBarUpdate();

			autoSyncInProgress.add(branchKey);
			try {
				const synced = await repositories.syncCurrentBranch(credentials, resolvedUri);
				if (synced) { scheduleStatusBarUpdate(); }
			} finally {
				autoSyncInProgress.delete(branchKey);
			}
		}, 2500));
	}

	context.subscriptions.push(
		{
			dispose: () => {
				if (updateTimer) { clearTimeout(updateTimer); }
				for (const timer of autoSyncTimersByRepo.values()) { clearTimeout(timer); }
			}
		},
		...repositories.subscribeToRepositoryStateChanges((uri) => {
			scheduleStatusBarUpdate();
			scheduleAutoSyncCheck(uri);
		}),
		...repositories.subscribeToCurrentBranchChanges(scheduleStatusBarUpdate),
		// Re-check after auth changes: Credentials.refresh() updates the token
		// internally but doesn't re-trigger the status bar. This ensures we
		// re-poll once the user (or another extension like Copilot) signs in.
		vscode.authentication.onDidChangeSessions((e) => {
			if (e.provider.id === 'github') {
				scheduleStatusBarUpdate();
				scheduleAutoSyncCheck();
			}
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (!e.affectsConfiguration('github-sync-fork')) { return; }
			scheduleStatusBarUpdate();
			scheduleAutoSyncCheck();
		})
	);

	scheduleStatusBarUpdate();
	scheduleAutoSyncCheck();

	context.subscriptions.push(
		vscode.commands.registerCommand('github-sync-fork.syncBranch', async (sourceControl?: vscode.SourceControl) => {
			await repositories.syncBranch(credentials, sourceControl?.rootUri);
			scheduleStatusBarUpdate();
		}),
		vscode.commands.registerCommand('github-sync-fork.createBranch', async (sourceControl?: vscode.SourceControl) => {
			await repositories.createBranchAndSync(credentials, sourceControl?.rootUri);
			scheduleStatusBarUpdate();
		})
	);
}

export function deactivate() {}
