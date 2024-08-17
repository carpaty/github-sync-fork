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
            if (repo.parent) {
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
                // add a theme icon to quick pick item 
                const items: vscode.QuickPickItem[] = branchList.map(({ name }) => ({
                    label: `$(git-branch) ${name}`,
                    description: name,
                }));

                vscode.window.showQuickPick(items, { placeHolder: `Choose the branch you want to sync from ${parentRepo}` }).then(selection => {
                    // the user canceled the selection
                    if (!selection) {
                        return;
                    }
                    vscode.window
                        .showInformationMessage(`Sync the '${selection.description}' branch of your GitHub fork with its upstream '${parentRepo}'?`, { modal: true }, "Sync")
                        .then(async (answer) => {
                            if (answer === `Sync`) {
                                await this.syncGitHubRepo(repoName, selection.description ?? '??', userInfo, octokit);
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
}
