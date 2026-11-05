# HiGhostty

English | [繁體中文](README.md)

macOS 13+ only. A Rust + Tauri shell embeds Ghostty 1.3.1 in a native AppKit view. CoreText and Metal handle fonts, Chinese input methods, and rendering.

## Development and packages

Requires Xcode, Rust, and Node.js 22.6+. The Ghostty bootstrap downloads and verifies a pinned Zig 0.15.2. The engine’s internal API is bound to that version’s headers; upgrades must be verified together.

```sh
npm install
npm run native:bootstrap
CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- dev
```

```sh
CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- build
```

The app is written to `/private/tmp/highostty-target/release/bundle/macos/HiGhostty.app`. A development build uses `build --debug` and lands in the matching `debug/bundle/macos` directory. Local builds are ad-hoc signed. Distribution needs a separate Developer ID signature and notarization.

Drop a folder onto the app icon in the Dock or Finder (or use Open With) to open a new tab in that directory. Dropping a file opens its parent directory.

The native Ghostty library includes arm64 and x86_64. A full universal app also needs both Rust targets, then Tauri `build --target universal-apple-darwin`. Interactive checks currently run on Apple Silicon only.

You can also build the arm64 Tauri app and the Intel Rust binary separately, then merge them with the packaging script:

```sh
rustup target add x86_64-apple-darwin
CARGO_TARGET_DIR=/private/tmp/highostty-target npm run tauri -- build --debug
CARGO_TARGET_DIR=/private/tmp/highostty-target cargo build --manifest-path src-tauri/Cargo.toml --target x86_64-apple-darwin --features tauri/custom-protocol
CARGO_TARGET_DIR=/private/tmp/highostty-target scripts/package-universal-macos.sh /private/tmp/HiGhostty-universal.app
```

The script keeps the arm64 app’s resources, merges the two Rust binaries, and ad-hoc signs the result. Public distribution still needs a Developer ID signature and notarization.

Bootstrap keeps sources, the toolchain, and its cache in `/private/tmp/highostty-native-build`, and copies artifacts into `src-tauri/vendor` (not committed). `HIGHOSTTY_BUILD_CACHE` changes the cache location. `HIGHOSTTY_ZIG` points at a Zig 0.15.2 binary.

When the Xcode 27 SDK uses arm64e libc stubs, bootstrap automatically picks the x86_64 Zig (Apple Silicon needs Rosetta). Metal shaders use the system runtime compiler, so no offline Metal toolchain is required. Compatibility patches touch only the downloaded sources and toolchain, not the system SDK.

On exFAT, AppleDouble `._` files are read by Tauri as config. Prefer an APFS working copy, and keep the Cargo target directory on `/private/tmp`. If a capability file fails with a UTF-8 error, remove `src-tauri/capabilities/._*` and rebuild.

## Build and release (xtask)

```sh
cargo xtask debug                  # dev mode (npm run tauri -- dev; output dir matches build)
cargo xtask build                  # build HiGhostty.app (--debug for a dev build)
cargo xtask publish                # pack a dmg and ask whether to copy it to ~/Applications (--install / --no-install)
cargo xtask clean                  # remove the Cargo output dir, dist, and intermediate artifacts; --all also removes src-tauri/vendor and node_modules
cargo xtask push -m "message"      # commit every change and push to GitHub; without -m, push commits that already exist
cargo xtask version                # current version, the next version suggested from commits, and the release command
cargo xtask release 0.2.1          # also accepts patch / minor / major; --install installs as well, -y skips confirmation
```

Cargo output defaults to `/private/tmp/highostty-target` (override with `CARGO_TARGET_DIR`). The dmg is written under `release/bundle/dmg/`. The version comes from `package.json`; `tauri.conf.json` references it directly. `release` updates `src-tauri/Cargo.toml` and both lockfiles. It requires a clean worktree on `main`, in sync with the remote, and a logged-in `gh`. A failed build restores the previous version. The first `push` creates the git repo and attaches the existing remote history.

## Shared Ghostty config

HiGhostty loads the existing config through Ghostty’s native parser, including themes and recursive `config-file` includes. It does not copy the file or rewrite the user’s settings. The settings button shows the shared file location and diagnostics, and can open the file or reload it.

Font, size, colors, cursor, shell, scrollback, shell integration, and custom shaders are handled by the Ghostty engine. Window and shortcut behavior is bridged by the host: new windows, tabs, splits, search, fullscreen, decorations, opacity, the quick terminal, and the global shortcut. A Ghostty binding wins over HiGhostty’s default ⌘O shortcut.

The native engine is separate from host features of the upstream macOS app. The upstream Inspector and auto-updater are not provided. An unimplemented host action is reported; it is not applied silently. Settings for other platforms, such as GTK, do not apply.

The global shortcut uses a macOS event tap and needs Accessibility permission for HiGhostty. Missing permission is reported; reload the config after granting it. If upstream Ghostty registers the same global shortcut, the two apps can compete for the event. Avoid registering the same shortcut in both.

## File preview

- Preview sits in the right half of the files overlay (the directory is on the left). Opening the overlay shows only the directory; selecting a file splits out the preview (rendered Markdown, plain text, images, PDF, and more). The preview updates when the file changes, which is useful while discussing a plan an agent is writing. Drag the divider to resize, collapse the directory to an icon row, or pop the preview out into its own window (and dock it back). Open it from the files panel context menu (“Open in preview”) or the command menu.
- An agent can open a file itself with `highostty ctl preview open <file>` (available in read-only mode). After the skill is installed, the agent knows about this. See `docs/preview.md`.

## Files panel and workspace

- The title bar leaves room on the left for the macOS window controls. Title text cannot be selected. Dragging the title area moves the window.
- The left chrome is an icon rail, a first drawer, and a second drawer. Workspaces, favorites, and settings open from the rail. An open drawer pushes the terminal aside. Drawer state is saved. Favorite-group contents and edit pages appear in the second drawer.
- Each tab has its own files panel. Toggle it with the folder button at the top right of the window, or with ⌘O (the letter O) or ⌘0, which also focuses it; press again to close. It defaults to the right of the terminal (drag to resize). ⇧⌘F or the title-bar button switches to full width. Open/closed and full-width state are saved with the tab, including favorites.
- The panel follows `cd` in the focused terminal. Browsing elsewhere pauses following; “Back to the terminal’s current directory” resumes it.
- Two views: list and three columns. The list expands subfolders and sorts by name, size, or modification date. Columns are parent | current | preview; the preview column shows folder contents or a file thumbnail and info. Both can show hidden files. Interaction matches Finder: ⌘/⇧ multi-select, Space for Quick Look, Enter to rename, ⌘C/⌘X/⌘V, ⌘D to duplicate, ⌘⌫ to trash, ⇧⌘N for a new folder, ⌘↓ to open, ⌘↑ for the parent.
- Copy, cut, and paste use the system clipboard and work with Finder. Pasting into text, including the terminal, inserts a quoted path. Name collisions are renamed automatically (`Name 2`, `Name copy`). Delete always moves items to the Trash.
- The context menu offers Open, Open With, Edit in terminal (runs `$EDITOR` in a split on the right), Insert path into the terminal, Copy path, Open a terminal in a new tab, and Reveal in Finder. Dragging files from Finder into the panel copies them into that folder.
- With no open tab, “Choose Folder…” uses the native macOS picker and opens a terminal there. Design notes are in `docs/files-panel.md`.
- Dropping a directory onto the terminal area creates a terminal tab. Dropping one onto favorites creates a favorite for that directory. Dropping a file or directory into the terminal pastes a shell path and does not run it.
- After `cd`, the tab and files panel follow the focused terminal immediately. This uses the native working-directory event. When shell integration is off, a lightweight cwd syscall once a second fills the gap.
- Groups sit above favorites and organize them. A favorite does not have to belong to a group. A group has a name and a color. Selecting a group lists its favorites in the second drawer, with “Open all”. Deleting a group moves its favorites to Ungrouped.
- An agent in the terminal can use `highostty ctl` to read other tabs and windows, run in a background tab and wait for output, notify the user, show a file, add a snippet, and start or direct other agents. The default is read-only. Settings can turn it off or switch to full access. `skills/highostty/SKILL.md` teaches agents these commands. Settings can install the skill into Claude Code, Codex, GitHub Copilot, and Gemini CLI, and can remove it. Design and the acceptance checklist are in `docs/agent-control.md`.
- A favorite stores one tab’s name, group, launch command, tmux option, directory, and split layout — the only copy of those fields. The favorite editor can be opened from any workspace row, including one that is not running. Name and tmux status-line changes apply immediately to an open tab. Command and tmux on/off apply the next time it opens. Split layout and the files-panel toggle are runtime state; they are written only when the editor’s “Update favorite from current layout” is used. Selecting a favorite switches to its open tab, or opens another copy. Favorites and groups can be reordered by drag. A favorite can be dragged into a group or back to Ungrouped.
- The workspace lists open tabs and, inside groups, favorites that are not open yet. Ungrouped tabs are on top. Below the divider, sections follow groups and use the group color. A colored dot or outline means a tab is open; a gray hollow dot means it is not. Selecting a favorite that is not open starts a terminal. A tab’s name and group come from the favorite it was opened from (double-click rename changes the favorite name). Drag reorders only within the same section. A tab can hold several split terminals. Double-click the name to set an alias.
- Legacy “group favorites” (a snapshot of several tabs) are split on first read into one group plus one favorite per tab. Group membership stored on workspace tabs in old sessions is no longer used.
- A tab launch command applies only to that tab’s primary terminal. It can run directly, or load the interactive shell from the Ghostty config and then run, leaving the shell after the command exits. The option is stored with the tab snapshot and the favorite. Favorites are shared across windows; a write notifies the other windows.
- ⌘1–⌘9 switch the first nine workspace tabs (the matching shortcut is shown at the right of the tab row; hover shows “…”, or use the context menu, to rename, edit, or close). ⌘⇧B toggles the sidebar (when collapsed, a tab-number strip stays beside the rail, showing ⌘1–⌘9 and attention state; a click switches tabs; the button at the bottom of the rail hides it). ⌘O or ⌘0 toggles the files panel.
- ⌘T opens a new tab. ⌘⇧T opens another terminal in the same directory (shown in the sidebar as a child of the original tab). ⌘D splits right, ⌘⇧D splits down, and ⌘W closes the current surface. These follow the shared Ghostty keybindings.
- Launch arguments: `highostty --tab <favorite name or ID>` (repeatable) opens that favorite. `--dir <directory>` (repeatable) opens a new tab in that directory. `--tab=name` is also accepted. By default this does not start a second instance: if HiGhostty is already running and agent control is not disabled, the arguments are handed off and this process exits. With no running instance, the app starts normally and opens the arguments after restoring the session. `--new` forces a new instance. `highostty --list-tabs` lists every favorite (name and ID, tab-separated). The favorite editor also shows a copyable launch command. A missing favorite is reported.
- Closing a window while any tab is open always asks “Don’t quit” or “Force quit all”. Closing a workspace or quitting from the app menu checks running work first. After confirmation, processes are cleaned up and the engine is given time to reap shells. PIDs are checked against start time so a reused PID is not killed.

Unified favorites live in `workspace-favorites-v2.json`. Existing `favorites.json` and `group-favorites.json` are migrated on first read; the old files are kept. `HIGHOSTTY_DATA_DIR` isolates development and test data in another directory. Old terminal processes are not restored across versions. “Restore closed” starts a new shell in the same directory; it does not resume work that already exited.

A process that deliberately daemonizes and leaves the terminal session and parent/child relationship cannot be guaranteed to be found again. This cleanup is not a process sandbox.

## Languages

Settings → Language chooses the UI locale (default: follow the system; English when no matching locale file exists). English and Traditional Chinese are built in. Locale files can be imported, exported, and edited in the app. User locale files live in `locales/` under the data directory. See `docs/i18n.md`.

## Checks

```sh
npm test
npm run build
CARGO_TARGET_DIR=/private/tmp/highostty-target cargo test --manifest-path src-tauri/Cargo.toml
```

Split-model tests cover split, remove, geometry, direction changes, and size limits. Rust tests cover home-directory and relative-path expansion. The interactive acceptance list is in `docs/verification.md`, with done and not-done items recorded separately.
