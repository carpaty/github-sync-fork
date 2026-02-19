import * as vscode from 'vscode';
import { Credentials } from "./cred";
import { Repositories } from "./repo";

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

	async function updateStatusBar() {
		const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!uri) { statusBar.hide(); return; }

		statusBar.text = '$(sync~spin) Fork';
		statusBar.show();

		const behind = await repositories.getForkBehindCount(credentials, uri);
		debugLog(`updateStatusBar: getForkBehindCount returned ${behind}`);
		if (behind === undefined) { debugLog('updateStatusBar: hiding status bar (undefined)'); statusBar.hide(); return; }

		statusBar.text = behind === 0 ? '$(check) Fork: up to date' : `$(sync) Fork: ${behind} behind`;
		debugLog(`updateStatusBar: showing "${statusBar.text}"`);
		statusBar.show();
	}

	function scheduleStatusBarUpdate() {
		if (updateTimer) { clearTimeout(updateTimer); }
		updateTimer = setTimeout(updateStatusBar, 2000);
	}

	context.subscriptions.push(
		{ dispose: () => { if (updateTimer) { clearTimeout(updateTimer); } } },
		...repositories.subscribeToCurrentBranchChanges(scheduleStatusBarUpdate),
		// Re-check after auth changes: Credentials.refresh() updates the token
		// internally but doesn't re-trigger the status bar. This ensures we
		// re-poll once the user (or another extension like Copilot) signs in.
		vscode.authentication.onDidChangeSessions((e) => {
			if (e.provider.id === 'github') { scheduleStatusBarUpdate(); }
		})
	);

	scheduleStatusBarUpdate();

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
