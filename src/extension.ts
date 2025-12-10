// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Credentials } from "./cred";
import { Repositories } from "./repo";

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "github-sync-fork" is now active!');


	const credentials = new Credentials(context);
	const repositories = new Repositories();

	const syncBranchDisposable = vscode.commands.registerCommand('github-sync-fork.syncBranch', async (sourceControl?: vscode.SourceControl) => {
		await repositories.syncBranch(credentials, sourceControl?.rootUri);
	});
	context.subscriptions.push(syncBranchDisposable);

	// New command: create a GitHub branch in the fork and sync it with upstream
	const createBranchDisposable = vscode.commands.registerCommand('github-sync-fork.createBranch', async (sourceControl?: vscode.SourceControl) => {
		await repositories.createBranchAndSync(credentials, sourceControl?.rootUri);
	});
	context.subscriptions.push(createBranchDisposable);

}

// This method is called when your extension is deactivated
export function deactivate() {}
