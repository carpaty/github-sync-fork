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

	const disposable = vscode.commands.registerCommand('github-sync-fork.upstream', async () => {
		const octokit = await credentials.getOctokit();
		const userInfo = await octokit.users.getAuthenticated();
		repositories.handleQuickPickList(userInfo, octokit);
	});

	context.subscriptions.push(disposable);

}

// This method is called when your extension is deactivated
export function deactivate() {}
