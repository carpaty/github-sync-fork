// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import { Credentials } from "./cred";
import { Repositories } from "./repo"

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "github-sync-fork" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json


	const credentials = new Credentials();
	const repositories = new Repositories();
	await credentials.initialize(context);

	const disposable = vscode.commands.registerCommand('github-sync-fork.upstream', async () => {
		const octokit = await credentials.getOctokit();
		const userInfo = await octokit.users.getAuthenticated();
		const quickPickList = await repositories.handleQuickPickList(userInfo, octokit);
	});

	context.subscriptions.push(disposable);

}

// This method is called when your extension is deactivated
export function deactivate() {}
