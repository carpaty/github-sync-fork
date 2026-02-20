# GitHub Sync Fork

Sync your GitHub fork branches with upstream directly from VS Code.

## Live Preview
![combined_1fps_1280x720](https://github.com/user-attachments/assets/211f09ec-713a-4a55-b8d1-be1fead77d53)


## Keyboard Shortcuts


This extension does not register a default direct hotkey for sync actions.
Use the Command Palette shortcut:

- macOS: `Cmd+Shift+P`
- Windows/Linux: `Ctrl+Shift+P`

Then run:
- `GitHub Sync Fork: Sync branch at GitHub from Upstream branch`
- `GitHub Sync Fork: Create GitHub branch linked to upstream`

### Optional: add your own shortcut

Open `Keyboard Shortcuts (JSON)` and add, for example:

```json
[
  {
    "key": "cmd+alt+s",
    "command": "github-sync-fork.syncBranch",
    "when": "scmProvider == git"
  }
]
```

## Features

- Sync a fork branch with its upstream branch
- Create a new fork branch from an upstream branch
- Status bar indicator for fork-behind state
- Optional auto-sync behavior

## Settings

All settings are under `github-sync-fork`.

### `github-sync-fork.debug`
- Type: `boolean`
- Default: `false`
- Enables debug logging in the **GitHub Sync Fork** output channel.

### `github-sync-fork.autoSyncOnPull`
- Type: `"off" | "prompt" | "always"`
- Default: `"off"`
- Controls auto-sync behavior when repository updates happen and the current branch is behind upstream.

### `github-sync-fork.autoSyncBranches`
- Type: `string[]`
- Default: `["main", "master"]`
- Branch patterns used for auto-sync eligibility.
- Supports `*` and `?` wildcards.
- Prefix with `!` to exclude a branch pattern (example: `!release/*`).

### `github-sync-fork.autoSyncCooldownMinutes`
- Type: `number`
- Default: `30`
- Minimum wait time between auto-sync actions/prompts for the same branch.

## License

MIT
