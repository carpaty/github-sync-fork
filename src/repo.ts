import { GetResponseDataTypeFromEndpointMethod } from '@octokit/types';
import { Octokit } from '@octokit/rest';
import * as vscode from 'vscode';
import * as git from '../git';
import { Credentials } from './cred';

type OctokitInstance = InstanceType<typeof Octokit>;
type GetBranchResponseDataType = GetResponseDataTypeFromEndpointMethod<OctokitInstance['repos']['getBranch']>;
type GetResponseDataType = GetResponseDataTypeFromEndpointMethod<OctokitInstance['repos']['get']>;
type ListBranchesResponseDataType = GetResponseDataTypeFromEndpointMethod<OctokitInstance['repos']['listBranches']>;
type GetAuthenticatedResponseDataType = GetResponseDataTypeFromEndpointMethod<OctokitInstance['users']['getAuthenticated']>;

interface BranchQuickPickItem extends vscode.QuickPickItem { branchName: string; }
interface BranchOptionItem extends vscode.QuickPickItem { branchName?: string; }

export class Repositories {

    private git: git.API | undefined;
    private log: (msg: string) => void;

    constructor(logger: (msg: string) => void = () => {}) {
        this.git = vscode.extensions.getExtension<git.GitExtension>('vscode.git')?.exports?.getAPI(1);
        this.log = logger;
    }

    private resolveUri(uri?: vscode.Uri): vscode.Uri | undefined {
        return uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    }

    // Parses both HTTPS and SSH GitHub remote URLs.
    private parseGitHubOwnerRepo(fetchUrl: string): { owner: string; repo: string } | undefined {
        // HTTPS: https://[credentials@]github.com/owner/repo[.git]
        const httpsMatch = fetchUrl.match(/^https?:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/)?$/);
        if (httpsMatch) { return { owner: httpsMatch[1], repo: httpsMatch[2] }; }

        // SSH: git@github.com:owner/repo[.git]
        const sshMatch = fetchUrl.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
        if (sshMatch) { return { owner: sshMatch[1], repo: sshMatch[2] }; }

        return undefined;
    }

    // Finds the best GitHub remote: tracking remote > 'origin' > any GitHub remote.
    // Falls back gracefully when the current branch has no upstream tracking set.
    private resolveGitHubRemote(repo: git.Repository): git.Remote | undefined {
        const remotes = repo.state.remotes;

        const trackingName = repo.state.HEAD?.upstream?.remote;
        if (trackingName) {
            const tracked = remotes.find(r => r.name === trackingName && !!r.fetchUrl && !!this.parseGitHubOwnerRepo(r.fetchUrl!));
            if (tracked) { return tracked; }
        }

        const githubRemotes = remotes.filter(r => !!r.fetchUrl && !!this.parseGitHubOwnerRepo(r.fetchUrl!));
        return githubRemotes.find(r => r.name === 'origin') ?? githubRemotes[0];
    }

    private getGitHubRepoName(owner: string, uri: vscode.Uri): string {
        const repo = this.git?.getRepository(uri);
        if (!repo) { return ""; }

        // Prefer the previously resolved "best" remote when it belongs to the
        // authenticated user. If the current branch tracks upstream, fall back
        // to a user-owned remote (origin first, then any matching GitHub remote).
        const primaryRemote = this.resolveGitHubRemote(repo);
        if (primaryRemote?.fetchUrl) {
            const parsed = this.parseGitHubOwnerRepo(primaryRemote.fetchUrl);
            if (parsed?.owner === owner) { return parsed.repo; }
        }

        const userRemotes = repo.state.remotes
            .filter(r => !!r.fetchUrl)
            .map(r => ({ remote: r, parsed: this.parseGitHubOwnerRepo(r.fetchUrl!) }))
            .filter((x): x is { remote: git.Remote; parsed: { owner: string; repo: string } } => !!x.parsed && x.parsed.owner === owner);

        const preferred = userRemotes.find(x => x.remote.name === 'origin') ?? userRemotes[0];
        return preferred?.parsed.repo ?? "";
    }

    private getCurrentBranchName(uri: vscode.Uri): string {
        return this.git?.getRepository(uri)?.state.HEAD?.name ?? "";
    }

    getCurrentBranch(uri: vscode.Uri): string {
        return this.getCurrentBranchName(uri);
    }

    private async getParentInfo(userInfo: GetAuthenticatedResponseDataType, octokit: Octokit, repoName: string): Promise<{ fullName: string; defaultBranch: string } | undefined> {
        try {
            const repo: GetResponseDataType = (await octokit.repos.get({ owner: userInfo.login, repo: repoName })).data;
            if (!repo.parent) { return undefined; }
            return { fullName: repo.parent.full_name, defaultBranch: repo.parent.default_branch };
        } catch {
            return undefined;
        }
    }

    private async getBranchList(userInfo: GetAuthenticatedResponseDataType, octokit: Octokit, uri: vscode.Uri): Promise<ListBranchesResponseDataType> {
        const repoName = this.getGitHubRepoName(userInfo.login, uri);
        if (!repoName) { return []; }

        const currentBranchName = this.getCurrentBranchName(uri);
        let currentBranch: GetBranchResponseDataType;
        try {
            currentBranch = (await octokit.repos.getBranch({ owner: userInfo.login, repo: repoName, branch: currentBranchName })).data;
        } catch {
            return [];
        }

        const branchList = await octokit.paginate(octokit.repos.listBranches, { owner: userInfo.login, repo: repoName, per_page: 100 });
        return [currentBranch, ...branchList.filter(b => b.name !== currentBranchName)];
    }

    private async getRepoContext(credentials: Credentials, uri: vscode.Uri) {
        const octokit = await credentials.getOctokit();
        const userInfo: GetAuthenticatedResponseDataType = (await octokit.users.getAuthenticated()).data;
        const repoName = this.getGitHubRepoName(userInfo.login, uri);
        return { octokit, userInfo, repoName };
    }

    private async fetchRemote(uri: vscode.Uri): Promise<void> {
        const repo = this.git?.getRepository(uri);
        const remoteName = repo?.state.HEAD?.upstream?.remote;
        if (remoteName) {
            try {
                await repo?.fetch(remoteName);
            } catch {
                // local fetch is best-effort
            }
        }
    }

    // Subscribes to branch switches across all open repositories.
    // Returns disposables that must be pushed to context.subscriptions.
    subscribeToCurrentBranchChanges(handler: () => void): vscode.Disposable[] {
        if (!this.git) { return []; }
        const lastBranchByRepo = new Map<git.Repository, string>();
        const disposables: vscode.Disposable[] = [];

        const watchRepo = (repo: git.Repository) => {
            lastBranchByRepo.set(repo, repo.state.HEAD?.name ?? '');
            disposables.push(repo.state.onDidChange(() => {
                const branch = repo.state.HEAD?.name ?? '';
                const previousBranch = lastBranchByRepo.get(repo) ?? '';
                if (branch !== previousBranch) {
                    lastBranchByRepo.set(repo, branch);
                    handler();
                }
            }));
        };

        this.git.repositories.forEach(watchRepo);
        disposables.push(this.git.onDidOpenRepository(watchRepo));
        return disposables;
    }

    // Subscribes to repository state changes for all open repositories.
    // Emits root URI so callers can scope background work.
    subscribeToRepositoryStateChanges(handler: (uri: vscode.Uri) => void): vscode.Disposable[] {
        if (!this.git) { return []; }
        const disposables: vscode.Disposable[] = [];

        const watchRepo = (repo: git.Repository) => {
            disposables.push(repo.state.onDidChange(() => handler(repo.rootUri)));
        };

        this.git.repositories.forEach(watchRepo);
        disposables.push(this.git.onDidOpenRepository(watchRepo));
        return disposables;
    }

    // Returns how many commits the current fork branch is behind the matching upstream branch,
    // or undefined if not applicable (not a fork, no upstream branch match, not authenticated).
    async getForkBehindCount(credentials: Credentials, uri: vscode.Uri): Promise<number | undefined> {
        this.log(`getForkBehindCount: uri=${uri.fsPath}`);
        try {
            const octokit = await credentials.tryGetOctokit();
            this.log(`getForkBehindCount: octokit=${octokit ? 'available' : 'undefined (not authenticated)'}`);
            if (!octokit) { return undefined; }

            const userInfo: GetAuthenticatedResponseDataType = (await octokit.users.getAuthenticated()).data;
            this.log(`getForkBehindCount: login=${userInfo.login}`);

            const repoName = this.getGitHubRepoName(userInfo.login, uri);
            this.log(`getForkBehindCount: repoName=${repoName || '(empty — not a GitHub repo or remote not matched)'}`);
            if (!repoName) { return undefined; }

            const parentInfo = await this.getParentInfo(userInfo, octokit, repoName);
            this.log(`getForkBehindCount: parentInfo=${parentInfo ? `${parentInfo.fullName} (default: ${parentInfo.defaultBranch})` : '(undefined — not a fork)'}`);
            if (!parentInfo) { return undefined; }

            const [parentOwner, parentRepo] = parentInfo.fullName.split('/');
            const branchName = this.getCurrentBranchName(uri);
            this.log(`getForkBehindCount: branchName=${branchName || '(empty)'}`);
            if (!branchName) { return undefined; }

            // Compare fork branch (base) against matching upstream branch (head).
            // If the upstream doesn't have the same branch name, fall back to the
            // upstream's default branch (e.g. fork is on 'master', upstream uses 'main').
            this.log(`getForkBehindCount: compareCommits base=${userInfo.login}:${branchName} head=${parentOwner}:${branchName}`);
            try {
                const { data } = await octokit.repos.compareCommits({
                    owner: parentOwner,
                    repo: parentRepo,
                    base: `${userInfo.login}:${branchName}`,
                    head: `${parentOwner}:${branchName}`
                });
                this.log(`getForkBehindCount: ahead_by=${data.ahead_by} status=${data.status}`);
                return data.ahead_by;
            } catch (err: any) {
                this.log(`getForkBehindCount: compareCommits failed — status=${err.status} message=${err.message} — branch not in upstream, hiding`);
                return undefined;
            }
        } catch (err: any) {
            this.log(`getForkBehindCount: outer catch — ${err.message}`);
            return undefined;
        }
    }

    async syncBranch(credentials: Credentials, uri?: vscode.Uri) {
        const resolvedUri = this.resolveUri(uri);
        if (!resolvedUri) { return; }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'GitHub Sync Fork',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Authenticating...' });
                const { octokit, userInfo, repoName } = await this.getRepoContext(credentials, resolvedUri);
                if (!repoName) {
                    vscode.window.showInformationMessage('Current workspace is not associated with a GitHub repository of yours.');
                    return;
                }

                progress.report({ message: 'Loading branches...' });
                const [branchList, parentInfo] = await Promise.all([
                    this.getBranchList(userInfo, octokit, resolvedUri),
                    this.getParentInfo(userInfo, octokit, repoName)
                ]);

                if (!branchList.length) {
                    vscode.window.showInformationMessage('No branches found.');
                    return;
                }
                if (!parentInfo) {
                    vscode.window.showInformationMessage(`Your GitHub repo '${repoName}' doesn't have an upstream.`);
                    return;
                }

                progress.report({ message: '' }); // clear message while user picks

                const items: BranchQuickPickItem[] = branchList.map(({ name }: { name: string }) => ({ label: `$(git-branch) ${name}`, branchName: name }));
                const selection = await vscode.window.showQuickPick(items, {
                    title: 'Sync Fork at GitHub from Upstream',
                    placeHolder: `Choose branch to sync from '${parentInfo.fullName}'`
                });
                if (!selection) { return; }

                const confirm = await vscode.window.showInformationMessage(
                    `Sync the '${selection.branchName}' branch of your GitHub fork with its upstream '${parentInfo.fullName}'?`,
                    { modal: true },
                    'Sync'
                );
                if (confirm !== 'Sync') { return; }

                progress.report({ message: `Syncing '${selection.branchName}'...` });
                try {
                    const res = await octokit.repos.mergeUpstream({ owner: userInfo.login, repo: repoName, branch: selection.branchName });
                    if (res.status === 200) {
                        vscode.window.showInformationMessage(`The '${selection.branchName}' branch of '${repoName}' has been synced with its upstream.`);
                    } else {
                        vscode.window.showInformationMessage(`Sync returned status ${res.status}.`);
                    }
                } catch (err: any) {
                    const msg = err.status === 409
                        ? `Branch '${selection.branchName}' has diverged from upstream and cannot be synced automatically. Reset or rebase it locally first.`
                        : `Failed to sync branch '${selection.branchName}': ${err.message}`;
                    vscode.window.showErrorMessage(msg);
                    return;
                }

                progress.report({ message: 'Updating local repository...' });
                await this.fetchRemote(resolvedUri);
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Error: ${err.message}`);
        }
    }

    // Syncs the current checked-out branch in the fork with upstream without user pickers.
    // Returns true when a sync was performed successfully, false when not applicable/failed.
    async syncCurrentBranch(credentials: Credentials, uri?: vscode.Uri, options?: { showSuccessMessage?: boolean }): Promise<boolean> {
        const resolvedUri = this.resolveUri(uri);
        if (!resolvedUri) { return false; }

        try {
            const octokit = await credentials.tryGetOctokit();
            if (!octokit) { return false; }

            const userInfo: GetAuthenticatedResponseDataType = (await octokit.users.getAuthenticated()).data;
            const repoName = this.getGitHubRepoName(userInfo.login, resolvedUri);
            if (!repoName) { return false; }

            const parentInfo = await this.getParentInfo(userInfo, octokit, repoName);
            if (!parentInfo) { return false; }

            const branchName = this.getCurrentBranchName(resolvedUri);
            if (!branchName) { return false; }

            await octokit.repos.mergeUpstream({ owner: userInfo.login, repo: repoName, branch: branchName });
            if (options?.showSuccessMessage) {
                vscode.window.showInformationMessage(`The '${branchName}' branch of '${repoName}' has been synced with its upstream.`);
            }

            await this.fetchRemote(resolvedUri);
            return true;
        } catch (err: any) {
            const message = err?.status === 409
                ? 'Auto-sync skipped because the branch has diverged from upstream.'
                : `Auto-sync failed: ${err?.message ?? 'Unknown error'}`;
            vscode.window.showWarningMessage(message);
            return false;
        }
    }

    async createBranchAndSync(credentials: Credentials, uri?: vscode.Uri) {
        const resolvedUri = this.resolveUri(uri);
        if (!resolvedUri) { return; }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: 'GitHub Sync Fork',
                cancellable: false
            }, async (progress) => {
                progress.report({ message: 'Authenticating...' });
                const { octokit, userInfo, repoName } = await this.getRepoContext(credentials, resolvedUri);
                if (!repoName) {
                    vscode.window.showInformationMessage('Current workspace is not associated with a GitHub repository of yours.');
                    return;
                }

                progress.report({ message: 'Loading upstream info...' });
                const parentInfo = await this.getParentInfo(userInfo, octokit, repoName);
                if (!parentInfo) {
                    vscode.window.showInformationMessage(`Your GitHub repo '${repoName}' doesn't have an upstream.`);
                    return;
                }
                const [parentOwner, parentRepo] = parentInfo.fullName.split('/');

                progress.report({ message: 'Loading upstream branches...' });
                const parentBranches = await octokit.paginate(octokit.repos.listBranches, { owner: parentOwner, repo: parentRepo, per_page: 100 });
                parentBranches.sort((a, b) => a.name.localeCompare(b.name));

                progress.report({ message: '' }); // clear message while user picks

                const branchItems: BranchOptionItem[] = [
                    ...parentBranches.map(b => ({ label: `$(git-branch) ${b.name}`, branchName: b.name })),
                    { label: 'Create new branch name...', branchName: undefined }
                ];

                const selectedBranchItem = await vscode.window.showQuickPick(branchItems, {
                    placeHolder: 'Select an upstream branch or create a new one',
                    title: 'Choose branch source'
                });
                if (!selectedBranchItem) { return; }

                const newBranchName = selectedBranchItem.branchName ?? await vscode.window.showInputBox({
                    prompt: 'Enter the name for the new branch to create in your fork',
                    placeHolder: 'e.g. feature/my-new-thing',
                    validateInput: (value) => value?.trim() ? null : 'Branch name is required'
                });
                if (!newBranchName) { return; }

                // Put matching upstream branch first
                const upstreamItems: BranchQuickPickItem[] = [
                    ...parentBranches.filter(b => b.name === newBranchName),
                    ...parentBranches.filter(b => b.name !== newBranchName)
                ].map(b => ({ label: `$(git-branch) ${b.name}`, branchName: b.name }));

                const upstreamSelection = await vscode.window.showQuickPick(upstreamItems, {
                    placeHolder: `Select upstream branch from '${parentInfo.fullName}' to base ${newBranchName} on`
                });
                if (!upstreamSelection) { return; }

                const confirm = await vscode.window.showInformationMessage(
                    `Create branch '${newBranchName}' in '${repoName}' based on '${parentInfo.fullName}:${upstreamSelection.branchName}'?`,
                    { modal: true },
                    'Yes'
                );
                if (confirm !== 'Yes') { return; }

                progress.report({ message: `Creating branch '${newBranchName}'...` });
                const upstreamBranch = (await octokit.repos.getBranch({ owner: parentOwner, repo: parentRepo, branch: upstreamSelection.branchName })).data;
                try {
                    await octokit.git.createRef({ owner: userInfo.login, repo: repoName, ref: `refs/heads/${newBranchName}`, sha: upstreamBranch.commit.sha });
                    vscode.window.showInformationMessage(`Branch '${newBranchName}' created in '${repoName}' from '${parentInfo.fullName}:${upstreamSelection.branchName}'.`);
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to create branch: ${err.message}`);
                    return;
                }

                try {
                    progress.report({ message: 'Syncing with upstream...' });
                    await octokit.repos.mergeUpstream({ owner: userInfo.login, repo: repoName, branch: newBranchName });
                } catch {
                    // ignore — branch already points to upstream SHA
                }

                progress.report({ message: 'Updating local repository...' });
                await this.fetchRemote(resolvedUri);
            });
        } catch (err: any) {
            vscode.window.showErrorMessage(`Error creating and syncing branch: ${err.message}`);
        }
    }
}
