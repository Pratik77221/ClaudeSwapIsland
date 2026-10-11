# Claude Island

Independent account switching for Claude Code. There is no dependency on claude-swap, Python, uv, a terminal command, or an external account manager.

Click the pill-shaped **Claude Island** icon in the Activity Bar, or run **Claude Island: Open Island**. **Open Dock** opens the bottom panel, and **Open Dashboard** opens an editor tab.

## Accounts

The first time the extension opens, it verifies and saves your current Claude subscription login in VS Code SecretStorage. To add another account, sign in to it through Claude Code, then click **Save current login**. Avoid logging out of your previous account first, since logout can revoke its saved refresh token.

Switching verifies the target account, refreshes an expired saved token when possible, and updates Claude's active credential and account identity files. It preserves unrelated settings, projects, and MCP logins. If a Claude view keeps its previous login in memory, reopen that view after switching.

The extension automatically captures newer credentials for accounts it already knows when Claude refreshes them. Existing backups made by other tools are not imported or read. Sign in and save any additional account you want to use here.

## Usage and automatic switching

Visible docks check quietly every three minutes by default. Set `swapIsland.refreshSeconds` to `0` for manual refresh only; the refresh button always remains available. Background checks update existing cards without a loading animation or rebuilding the account list.

Usage is requested directly from Anthropic, cached for two minutes, and backed off for five minutes after a rate-limit response. Unknown usage stays unknown. Idle expired accounts are refreshed when explicitly switched to, rather than silently rotating every saved refresh token while polling.

Auto-switch starts off each session. When enabled, it checks every minute while VS Code remains open. It considers both five-hour and weekly usage, requires known usage for both windows, skips paused or expired accounts, requires at least five percentage points of improvement, and enforces a five-minute cooldown. Enable it in one VS Code window. A request already underway may finish when the toggle is disabled.

## Storage and safeguards

Saved account credentials and an interrupted-switch recovery journal are kept in **VS Code SecretStorage**, not plain JSON backups. Claude Code's own active `.credentials.json` remains in Claude's normal format. Secrets never enter the UI, logs, analytics, or command arguments. No telemetry and no remote UI assets.

All authenticated network calls go directly to `api.anthropic.com` or `platform.claude.com`; redirects are not followed. Account switching cooperates with Claude Code's credential and configuration locks, uses atomic file replacement, and retains encrypted recovery data until both files are committed. A failed second write restores the previous login when the files still match the transaction.

Supports Windows and Linux file-based Claude subscription logins. macOS Keychain, API keys, third-party providers, and environment-token overrides are not supported. `CLAUDE_CONFIG_DIR` is respected. The account file formats and OAuth usage endpoints are compatibility interfaces and may change with Claude Code updates. This is an independent extension, not an Anthropic product.

## Install and develop

Install `claude-swap-island-0.2.2.vsix`, then reload VS Code. The existing extension identifier is retained so this updates your previous installation.

`npm install`, `npm run check`, `npm test`, and `npm run package`. The VSIX bundles its small locking library and needs no separate runtime installation. `npm run test:ui` checks the webview with synthetic accounts. Tests for native switching use temporary Claude profiles and fake tokens, never your production credentials.
