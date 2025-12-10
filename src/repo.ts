import { GetResponseDataTypeFromEndpointMethod } from '@octokit/types';
import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';
import * as git from '../git';
import { Credentials } from './cred';

const octokit = new Octokit();

type GetBranchResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof octokit.repos.getBranch>;
type GetResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof octokit.repos.get>;
type ListBranchesResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof octokit.repos.listBranches>;
type GetAuthenticatedResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof octokit.users.getAuthenticated>;

export class Repositories {

    private git: git.API | undefined;

    constructor() {
        // Make the built-in Git extension's API available
        this.git = vscode.extensions.getExtension<git.GitExtension>('vscode.git')?.exports?.getAPI(1);
    }

    private getGitHubRepoName(owner: string, uri: vscode.Uri):string {
        const repo = this.git?.getRepository(uri);
        if (!repo) {
            return "";
        }
        const remote = repo.state.remotes.find(remote => remote.name === repo.state.HEAD?.upstream?.remote);
        if (!remote?.fetchUrl) {
            return "";
        }
        const fetchUri = vscode.Uri.parse(remote.fetchUrl);
        if (fetchUri.authority !== 'github.com') {
            return "";
        }
        if (fetchUri.path.split('/')[1] !== owner) {
            return "";
        }
        const name = fetchUri.path.split('/').pop();
        return name?.endsWith('.git') ? name.slice(0, -4) : name ?? "";
    }

    private getCurrentBranchName(uri: vscode.Uri):string {
        const repo = this.git?.getRepository(uri);
        return repo ? repo.state.HEAD?.name ?? "" : "";
    }
    
    private async getParentName(userInfo: GetAuthenticatedResponseDataType, octokit: Octokit, repoName: string){
        try {
            const repo: GetResponseDataType = (await octokit.repos.get({ owner: userInfo.login, repo: repoName })).data;
            if (repo && repo.parent) {
                return repo.parent.full_name;
            }
        } catch (err) {
            console.log(err);
        }
        return;
    }
    
    private async getBranchList(userInfo: GetAuthenticatedResponseDataType, octokit: Octokit, uri: vscode.Uri): Promise<ListBranchesResponseDataType> {
        let branchList: ListBranchesResponseDataType;
        const repoName = this.getGitHubRepoName(userInfo.login, uri);
        if (repoName === "") {
            return [];
        }
        const currentBranchName = this.getCurrentBranchName(uri);
        let currentBranch: GetBranchResponseDataType;
        try {
            currentBranch = (await octokit.repos.getBranch({ owner: userInfo.login, repo: repoName, branch: currentBranchName })).data;
        } catch (err: any) {
            return [];
        }
        branchList = (await octokit.repos.listBranches({ owner: userInfo.login, repo: repoName, per_page: 100 })).data ?? [];

        // Put current branch first in the list
        return [ currentBranch, ...branchList?.filter((branch: any) => branch.name !== currentBranchName) ];
    }

    private async syncGitHubRepo(repoName: string, branch: string, userInfo: GetAuthenticatedResponseDataType, octokit: Octokit) {
        let message = 'Unable to sync on GitHub';
        try {

            const result = await octokit.repos.mergeUpstream({
                owner: userInfo.login,
                repo: repoName,
                branch: branch,
                
            });
            if (result) {
                if (result.status === 200) {
                    message = `The '${branch}' branch of your '${repoName}' fork has been synced with its upstream.`;
                }
            }
        } catch (err: any) {
            message = err.message;
        } finally {
            vscode.window.showInformationMessage(message);
        }
    }

    async handleQuickPickList(credentials: Credentials, uri?: vscode.Uri) {
        if (!uri) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return;
            }
            uri = workspaceFolders[0]?.uri;
        }
        if (!uri) {
            return;
        }
        const octokit = await credentials.getOctokit();
        const userInfo: GetAuthenticatedResponseDataType = (await octokit.users.getAuthenticated()).data;
        const repoName = this.getGitHubRepoName(userInfo.login, uri);
        if (repoName === "") {
            vscode.window.showInformationMessage('Current workspace is not associated with a GitHub repository of yours.');
            return;
        }
        const branchList = await this.getBranchList(userInfo, octokit, uri);
        if (!branchList) {
            vscode.window.showInformationMessage('No branches found');
            return;
        }
        const parentRepo = await this.getParentName(userInfo, octokit, repoName);
        try {
            if (branchList && parentRepo) {
                // add a theme icon to quick pick item label
                interface BranchQuickPickItem extends vscode.QuickPickItem {
                    branchName: string;
                }
                const items: BranchQuickPickItem[] = branchList.map(({ name }) => ({
                    label: `$(git-branch) ${name}`,
                    branchName: name
                }));

                vscode.window.showQuickPick(items, { title: `Sync Fork at GitHub from Upstream`, placeHolder: `Choose branch to sync from '${parentRepo}'` }).then(selection => {
                    // the user canceled the selection
                    if (!selection) {
                        return;
                    }
                    vscode.window
                        .showInformationMessage(`Sync the '${selection.branchName}' branch of your GitHub fork with its upstream '${parentRepo}'?`, { modal: true }, "Sync")
                        .then(async (answer) => {
                            if (answer === `Sync`) {
                                await this.syncGitHubRepo(repoName, selection.branchName ?? '??', userInfo, octokit);
                                const remoteName = this.git?.getRepository(uri)?.state?.HEAD?.upstream?.remote;
                                if (remoteName) {
                                    await this.git?.getRepository(uri)?.fetch(remoteName);
                                }
                            }
                        });
                });
            } else {
                vscode.window.showInformationMessage(`Your GitHub repo '${repoName}' doesn't have an upstream.`);
            }
        } catch (err) {
            console.log(err);
        }
    }

    async createBranchAndSync(credentials: Credentials, uri?: vscode.Uri) {
        if (!uri) {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
                return;
            }
            uri = workspaceFolders[0]?.uri;
        }
        if (!uri) {
            return;
        }

        try {
            const octo = await credentials.getOctokit();
            const userInfo: GetAuthenticatedResponseDataType = (await octo.users.getAuthenticated()).data;
            const repoName = this.getGitHubRepoName(userInfo.login, uri);
            if (!repoName) {
                vscode.window.showInformationMessage('Current workspace is not associated with a GitHub repository of yours.');
                return;
            }

            const parentFull = await this.getParentName(userInfo, octo, repoName);
            if (!parentFull) {
                vscode.window.showInformationMessage(`Your GitHub repo '${repoName}' doesn't have an upstream.`);
                return;
            }
            const [parentOwner, parentRepo] = parentFull.split('/');

            // Ask for new branch name - first try to get existing branch name from upstream
            let newBranchName: string | undefined;
            const parentBranches = (await octo.repos.listBranches({ owner: parentOwner, repo: parentRepo, per_page: 100 })).data ?? [];

            // Sort upstream branches by name
            parentBranches.sort((a, b) => a.name.localeCompare(b.name));

            // Show quick pick with upstream branches first
            const branchOptions = [
                ...parentBranches.map(b => b.name),
                'Create new branch name...'
            ];

            const selectedBranch = await vscode.window.showQuickPick(branchOptions, {
                placeHolder: 'Select an upstream branch or create a new one',
                title: 'Choose branch source'
            });

            if (!selectedBranch) {
                return;
            }

            // If user selected to create new branch name
            if (selectedBranch === 'Create new branch name...') {
                newBranchName = await vscode.window.showInputBox({
                    prompt: 'Enter the name for the new branch to create in your fork',
                    placeHolder: 'e.g. feature/my-new-thing',
                    validateInput: (value) => value && value.trim().length > 0 ? null : 'Branch name is required'
                });
            } else {
                // User selected an existing upstream branch
                newBranchName = selectedBranch;
            }

            if (!newBranchName) {
                return;
            }

            // List upstream branches to pick the source
            let upstreamBranches = parentBranches.map(b => b.name);

            // If the new branch name matches an upstream branch, put it first
            if (upstreamBranches.includes(newBranchName)) {
                upstreamBranches = upstreamBranches.filter(name => name !== newBranchName);
                upstreamBranches.unshift(newBranchName);
            }

            const upstreamBranchName = await vscode.window.showQuickPick(upstreamBranches, {
                placeHolder: `Select upstream branch from '${parentFull}' to base ${newBranchName} on`,
                canPickMany: false
            });
            if (!upstreamBranchName) {
                return;
            }

            // Show confirmation message before creating branch
            const confirmCreate = await vscode.window.showInformationMessage(
                `Create branch '${newBranchName}' in '${repoName}' based on '${parentFull}:${upstreamBranchName}'?`,
                { modal: true },
                'Yes'
            );

            if (confirmCreate !== 'Yes') {
                return;
            }

            // Get SHA of upstream branch
            const upstreamBranch = (await octo.repos.getBranch({ owner: parentOwner, repo: parentRepo, branch: upstreamBranchName })).data;
            const upstreamSha = upstreamBranch.commit.sha;

            // Create the new branch ref in the user's fork pointing to upstream SHA
            try {
                await octo.git.createRef({
                    owner: userInfo.login,
                    repo: repoName,
                    ref: `refs/heads/${newBranchName}`,
                    sha: upstreamSha
                });
                vscode.window.showInformationMessage(`Branch '${newBranchName}' created in '${repoName}' from '${parentFull}:${upstreamBranchName}'.`);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to create branch: ${err.message}`);
                return;
            }

            // Optionally call mergeUpstream to ensure any additional upstream metadata is applied
            try {
                await octo.repos.mergeUpstream({
                    owner: userInfo.login,
                    repo: repoName,
                    branch: newBranchName
                });
            } catch (err) {
                // ignore mergeUpstream errors, branch already points to upstream
                console.log('mergeUpstream error', err);
            }

            // Fetch the remote locally so local repo can see the new branch
            const remoteName = this.git?.getRepository(uri)?.state?.HEAD?.upstream?.remote;
            if (remoteName) {
                try {
                    await this.git?.getRepository(uri)?.fetch(remoteName);
                } catch (err) {
                    console.log('Local fetch error', err);
                }
            }

        } catch (err: any) {
            vscode.window.showErrorMessage(`Error creating and syncing branch: ${err.message}`);
        }
    }
}
