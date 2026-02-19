import * as assert from 'assert';
import * as vscode from 'vscode';
import { Credentials } from '../cred';
import { Repositories } from '../repo';

type ChangeListener = () => void;

interface MockRepoState {
    remotes: Array<{ name: string; fetchUrl?: string }>;
    HEAD?: { name?: string; upstream?: { remote?: string } };
    onDidChange: (listener: ChangeListener) => vscode.Disposable;
}

interface MockRepository {
    state: MockRepoState;
}

interface MockGitApi {
    repositories: MockRepository[];
    getRepository: (_uri: vscode.Uri) => MockRepository | undefined;
    onDidOpenRepository: (_listener: (repo: MockRepository) => void) => vscode.Disposable;
}

function disposable(): vscode.Disposable {
    return { dispose: () => {} };
}

function createRepo(initialBranch: string, remotes: Array<{ name: string; fetchUrl?: string }>, upstreamRemote?: string) {
    const listeners: ChangeListener[] = [];
    const repo: MockRepository = {
        state: {
            remotes,
            HEAD: {
                name: initialBranch,
                upstream: upstreamRemote ? { remote: upstreamRemote } : undefined
            },
            onDidChange: (listener: ChangeListener) => {
                listeners.push(listener);
                return disposable();
            }
        }
    };

    return {
        repo,
        emitChange: () => listeners.forEach(listener => listener()),
        setBranch: (name: string) => {
            if (!repo.state.HEAD) {
                repo.state.HEAD = { name };
                return;
            }
            repo.state.HEAD.name = name;
        }
    };
}

function withMockGitApi<T>(gitApi: MockGitApi, run: () => Promise<T> | T): Promise<T> | T {
    const extensions = vscode.extensions as unknown as { getExtension: typeof vscode.extensions.getExtension };
    const originalGetExtension = extensions.getExtension;

    extensions.getExtension = ((id: string) => {
        if (id !== 'vscode.git') { return undefined; }
        return {
            exports: {
                getAPI: () => gitApi
            }
        } as unknown as vscode.Extension<unknown>;
    }) as typeof vscode.extensions.getExtension;

    const finalize = () => {
        extensions.getExtension = originalGetExtension;
    };

    try {
        const result = run();
        if (result instanceof Promise) {
            return result.finally(finalize);
        }
        finalize();
        return result;
    } catch (err) {
        finalize();
        throw err;
    }
}

suite('Repositories', () => {
    test('getGitHubRepoName falls back to user-owned remote when tracking upstream', async () => {
        const uri = vscode.Uri.file('/workspace/repo');
        const repo = createRepo('main', [
            { name: 'upstream', fetchUrl: 'git@github.com:upstream-owner/project.git' },
            { name: 'origin', fetchUrl: 'git@github.com:user-owner/project.git' }
        ], 'upstream').repo;

        const gitApi: MockGitApi = {
            repositories: [repo],
            getRepository: () => repo,
            onDidOpenRepository: () => disposable()
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            const repoName = (repositories as unknown as { getGitHubRepoName: (owner: string, uri: vscode.Uri) => string })
                .getGitHubRepoName('user-owner', uri);

            assert.strictEqual(repoName, 'project');
        });
    });

    test('getGitHubRepoName supports HTTPS GitHub remotes', async () => {
        const uri = vscode.Uri.file('/workspace/repo');

        const httpsRepo = createRepo('main', [
            { name: 'origin', fetchUrl: 'https://github.com/user-owner/project.git' }
        ], 'origin').repo;
        const tokenHttpsRepo = createRepo('main', [
            { name: 'origin', fetchUrl: 'https://token@github.com/user-owner/project.git' }
        ], 'origin').repo;

        const repositoriesByPath = new Map<string, MockRepository>([
            ['/workspace/repo-https', httpsRepo],
            ['/workspace/repo-token-https', tokenHttpsRepo]
        ]);

        const gitApi: MockGitApi = {
            repositories: [httpsRepo, tokenHttpsRepo],
            getRepository: (targetUri) => repositoriesByPath.get(targetUri.fsPath),
            onDidOpenRepository: () => disposable()
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            const repositoriesWithPrivate = repositories as unknown as { getGitHubRepoName: (owner: string, uri: vscode.Uri) => string };

            const repoNameHttps = repositoriesWithPrivate.getGitHubRepoName('user-owner', vscode.Uri.file('/workspace/repo-https'));
            assert.strictEqual(repoNameHttps, 'project');

            const repoNameTokenHttps = repositoriesWithPrivate.getGitHubRepoName('user-owner', vscode.Uri.file('/workspace/repo-token-https'));
            assert.strictEqual(repoNameTokenHttps, 'project');

            // wrong owner should not resolve
            const wrongOwner = repositoriesWithPrivate.getGitHubRepoName('another-owner', vscode.Uri.file('/workspace/repo-https'));
            assert.strictEqual(wrongOwner, '');
        });
    });

    test('subscribeToCurrentBranchChanges tracks branch per repository', async () => {
        const repoA = createRepo('main', [{ name: 'origin', fetchUrl: 'git@github.com:user/repo-a.git' }]);
        const repoB = createRepo('main', [{ name: 'origin', fetchUrl: 'git@github.com:user/repo-b.git' }]);
        let openedRepoListener: ((repo: MockRepository) => void) | undefined;

        const gitApi: MockGitApi = {
            repositories: [repoA.repo, repoB.repo],
            getRepository: () => repoA.repo,
            onDidOpenRepository: (listener) => {
                openedRepoListener = listener;
                return disposable();
            }
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            let count = 0;
            repositories.subscribeToCurrentBranchChanges(() => { count += 1; });

            repoA.setBranch('feature/a');
            repoA.emitChange();
            assert.strictEqual(count, 1);

            repoB.emitChange();
            assert.strictEqual(count, 1);

            repoB.setBranch('feature/b');
            repoB.emitChange();
            assert.strictEqual(count, 2);

            repoA.setBranch('shared');
            repoA.emitChange();
            repoB.setBranch('shared');
            repoB.emitChange();
            assert.strictEqual(count, 4);

            assert.ok(openedRepoListener, 'expected onDidOpenRepository listener to be registered');
        });
    });

    test('getForkBehindCount returns undefined when not authenticated', async () => {
        const uri = vscode.Uri.file('/workspace/repo');
        const repo = createRepo('main', [{ name: 'origin', fetchUrl: 'git@github.com:user-owner/project.git' }], 'origin').repo;
        const gitApi: MockGitApi = {
            repositories: [repo],
            getRepository: () => repo,
            onDidOpenRepository: () => disposable()
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            const credentials = {
                tryGetOctokit: async () => undefined
            } as unknown as Credentials;

            const behind = await repositories.getForkBehindCount(credentials, uri);
            assert.strictEqual(behind, undefined);
        });
    });

    test('getForkBehindCount returns undefined when repo is not a fork', async () => {
        const uri = vscode.Uri.file('/workspace/repo');
        const repo = createRepo('main', [{ name: 'origin', fetchUrl: 'git@github.com:user-owner/project.git' }], 'origin').repo;
        const gitApi: MockGitApi = {
            repositories: [repo],
            getRepository: () => repo,
            onDidOpenRepository: () => disposable()
        };

        const octokit = {
            users: {
                getAuthenticated: async () => ({ data: { login: 'user-owner' } })
            },
            repos: {
                get: async () => ({ data: { parent: undefined } }),
                compareCommits: async () => ({ data: { ahead_by: 0, status: 'identical' } })
            }
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            const credentials = {
                tryGetOctokit: async () => octokit
            } as unknown as Credentials;

            const behind = await repositories.getForkBehindCount(credentials, uri);
            assert.strictEqual(behind, undefined);
        });
    });

    test('getForkBehindCount returns undefined when compare fails', async () => {
        const uri = vscode.Uri.file('/workspace/repo');
        const repo = createRepo('main', [{ name: 'origin', fetchUrl: 'git@github.com:user-owner/project.git' }], 'origin').repo;
        const gitApi: MockGitApi = {
            repositories: [repo],
            getRepository: () => repo,
            onDidOpenRepository: () => disposable()
        };

        const octokit = {
            users: {
                getAuthenticated: async () => ({ data: { login: 'user-owner' } })
            },
            repos: {
                get: async () => ({ data: { parent: { full_name: 'upstream-owner/project', default_branch: 'main' } } }),
                compareCommits: async () => {
                    throw Object.assign(new Error('Not Found'), { status: 404 });
                }
            }
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            const credentials = {
                tryGetOctokit: async () => octokit
            } as unknown as Credentials;

            const behind = await repositories.getForkBehindCount(credentials, uri);
            assert.strictEqual(behind, undefined);
        });
    });

    test('getForkBehindCount returns ahead_by from compare', async () => {
        const uri = vscode.Uri.file('/workspace/repo');
        const repo = createRepo('main', [{ name: 'origin', fetchUrl: 'git@github.com:user-owner/project.git' }], 'origin').repo;
        const gitApi: MockGitApi = {
            repositories: [repo],
            getRepository: () => repo,
            onDidOpenRepository: () => disposable()
        };

        const octokit = {
            users: {
                getAuthenticated: async () => ({ data: { login: 'user-owner' } })
            },
            repos: {
                get: async () => ({ data: { parent: { full_name: 'upstream-owner/project', default_branch: 'main' } } }),
                compareCommits: async () => ({ data: { ahead_by: 7, status: 'ahead' } })
            }
        };

        await withMockGitApi(gitApi, async () => {
            const repositories = new Repositories();
            const credentials = {
                tryGetOctokit: async () => octokit
            } as unknown as Credentials;

            const behind = await repositories.getForkBehindCount(credentials, uri);
            assert.strictEqual(behind, 7);
        });
    });

});
