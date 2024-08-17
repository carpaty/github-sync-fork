import { GetResponseDataTypeFromEndpointMethod } from '@octokit/types';
import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';
import * as git from '../git';

const octokit = new Octokit();

type GetBranchResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof octokit.repos.getBranch>;
type ListBranchesResponseDataType = GetResponseDataTypeFromEndpointMethod<typeof octokit.repos.listBranches>;

export class Repositories {

    private git: git.API | undefined;

    constructor() {
        // Make the built-in Git extension's API available
        this.git = vscode.extensions.getExtension<git.GitExtension>('vscode.git')?.exports?.getAPI(1);
    }

    getRepoName(){
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].name;
        }
        return "Unknown";
    }

    getCurrentBranchName(): string{
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return this.git?.getRepository(workspaceFolders[0].uri)?.state.HEAD?.name ?? "";
        }
        return "";
    }
    
    async getParentName(userInfo: any, octokit: Octokit, repoName: any){
        let parentRepo;

        try {
            parentRepo = await octokit.repos.get({ owner: userInfo.data.login, repo: repoName });
            if (parentRepo.data.parent) {
                return parentRepo.data.parent.full_name;
            }
        } catch (err) {
            console.log(err);
        }
        return;
    }
    
    async getBranchList(userInfo: any, octokit: Octokit): Promise<ListBranchesResponseDataType> {
        let branchList: ListBranchesResponseDataType;
        const repoName = this.getRepoName();
        const currentBranchName = this.getCurrentBranchName();
        let currentBranch: GetBranchResponseDataType;
        currentBranch = (await octokit.repos.getBranch({ owner: userInfo.data.login, repo: repoName, branch: currentBranchName })).data;
        branchList = (await octokit.repos.listBranches({ owner: userInfo.data.login, repo: repoName, per_page: 100 })).data ?? [];

        // Put current branch first in the list
        return [ currentBranch, ...branchList?.filter((branch: any) => branch.name !== currentBranchName) ];
    }

    async syncGitHubRepo(repo: any, branch: any, userInfo: any, octokit: Octokit) {
        let message = 'Unable to sync on GitHub';
        try {

            const result = await octokit.repos.mergeUpstream({
                owner: userInfo.data.login,
                repo: repo,
                branch: branch,
                
            });
            if (result) {
                if (result.status === 200) {
                    message = `The '${branch}' branch of your '${repo}' fork has been synced with its upstream`;
                }
            }
        } catch (err: any) {
            message = err.message;
        } finally {
            vscode.window.showInformationMessage(message);
        }
    }
    async handleQuickPickList(userInfo: any, octokit: Octokit) {
        const branchList = await this.getBranchList(userInfo, octokit);
        const repoName = this.getRepoName();
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
                        .then(answer => {
                            if (answer === `Sync`) {
                                this.syncGitHubRepo(repoName, selection.description, userInfo, octokit);
                            }
                        });
                });
            } else {
                vscode.window.showInformationMessage(`Your repo ${repoName} doesn't have any upstream.`);
            }
        } catch (err) {
            console.log(err);
        }

    }
}