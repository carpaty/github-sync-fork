import * as vscode from 'vscode';
import { Octokit } from '@octokit/rest';

const GITHUB_AUTH_PROVIDER_ID = 'github';
const SCOPES = ['user:email', 'repo', 'workflow'];

export class Credentials {
	private octokit: Octokit | undefined;

	constructor(context: vscode.ExtensionContext) {
		context.subscriptions.push(
			vscode.authentication.onDidChangeSessions(async (e) => {
				if (e.provider.id === GITHUB_AUTH_PROVIDER_ID) {
					await this.refresh();
				}
			})
		);
	}

	private async refresh(): Promise<void> {
		const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: false });
		this.octokit = session ? new Octokit({ auth: session.accessToken }) : undefined;
	}

	async getOctokit(): Promise<Octokit> {
		if (!this.octokit) {
			const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: true });
			this.octokit = new Octokit({ auth: session.accessToken });
		}
		return this.octokit;
	}

	// Like getOctokit but never prompts — returns undefined if not authenticated.
	// Used by background operations like the status bar.
	async tryGetOctokit(): Promise<Octokit | undefined> {
		if (!this.octokit) {
			const session = await vscode.authentication.getSession(GITHUB_AUTH_PROVIDER_ID, SCOPES, { createIfNone: false });
			if (!session) { return undefined; }
			this.octokit = new Octokit({ auth: session.accessToken });
		}
		return this.octokit;
	}
}
