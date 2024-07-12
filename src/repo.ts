import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';

export class Repositories {

    async getrepoName(){
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            return workspaceFolders[0].name;
        }
        return "Unknown";
    }
    
    async getParentName(userInfo: any, octokit: Octokit, repoName: any){
        let parentRepo;

        try {
            parentRepo = await octokit.repos.get({ owner: userInfo.data.login, repo: repoName });
            if (parentRepo.data.parent) {
                return parentRepo.data.parent.full_name
            }
        } catch (err) {
            console.log(err);
        }
        return;
    }
    
    async getBranchList(userInfo: any, octokit: Octokit) {
        let branchList;
        const repoName = await this.getrepoName();
          
        try {
            branchList = await octokit.repos.listBranches({ owner: userInfo.data.login, repo: repoName, per_page: 100 });
            return branchList;

        } catch (err) {
            console.log(err);
        }
        return branchList;
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
                    message = `Your branch ${branch} has been sync with ${repo}`;
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
        const repoName = await this.getrepoName();
        const parentRepo = await this.getParentName(userInfo, octokit, repoName);
        try {
            if (branchList && parentRepo) {
                // add a theme icon to quick pick item 
                const items: vscode.QuickPickItem[] = branchList.data.map(({ name }) => ({
                    label: `$(git-branch) ${name}`,
                    description: name,
                }));

                vscode.window.showQuickPick(items, { placeHolder: `Choose the branch you want to sync from ${parentRepo}` }).then(selection => {
                    // the user canceled the selection
                    if (!selection) {
                        return;
                    }
                    vscode.window
                        .showInformationMessage(`Sync ${selection.description} from upsrteam ${parentRepo}`, "Sync", "Cancel")
                        .then(answer => {
                            if (answer === `Sync`) {
                                this.syncGitHubRepo(repoName, selection.description, userInfo, octokit);
                            }
                        });
                });
            } else {
                vscode.window.showInformationMessage(`Your repo ${repoName} doesn't have any upstream dependencies.`);
            }
        } catch (err) {
            console.log(err);
        }

    }
}