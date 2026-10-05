# Agent guidelines

## Git delivery

- Do every complex task — anything beyond a parameter change or a few localized lines — in a dedicated Git worktree on its own branch, not in the main checkout, which may hold the user's uncommitted work. Create the worktree as a **sibling directory of the main checkout** (e.g. `git worktree add ../TJXY_app-<task> -b <branch>`): `apps/desktop`'s Tauri config resolves the sibling frontend through the relative path `../../../../TJXY/admin`, so the worktree must sit at the same directory depth as `TJXY_app`. Then run `pnpm install` inside the worktree (Node.js 22+, pnpm 10; the `heroui-native-pro` package needs `HEROUI_AUTH_TOKEN`/`HEROUI_KEY` in the environment; if pnpm reports the Skia install script was skipped, run `pnpm exec install-skia` before Android builds).
- Hand the result back locally: bring the branch into the main checkout (fast-forward or cherry-pick) without modifying the user's uncommitted changes, rerun the relevant checks there, then remove the worktree and its branch (`git worktree remove` also deletes ignored `node_modules`, `.expo`, `dist`, and `target` output). Note: `tauri build`'s `beforeBuildCommand` writes frontend assets to the hard-coded path `../../TJXY_app/apps/desktop/dist` — i.e. the main checkout — so desktop builds from a worktree still emit there. `dist` is gitignored; leave it in place.
- After completing each task, create one or more Git commits for the changes made in that task.
- Group commits by change category or repository responsibility when the task includes unrelated changes.
- Run the relevant validation commands before committing whenever practical, and mention any validation that could not be run:
  - `pnpm test` (root) / `pnpm --filter @tjxy/client-api test` — node:test suite for the shared client.
  - `pnpm --filter mobile typecheck` — `tsc --noEmit` for the Expo app.
  - `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` — for desktop Rust changes.
  - `pnpm --filter desktop build` — full desktop verification; also type-checks and builds the sibling `../TJXY/admin` frontend, so it is heavy and requires that repo to be installed. Reserve for desktop changes.
  - No linter/formatter is configured in this repo.
- Push the created commits to the current branch's upstream remote after committing.
- If committing or pushing is blocked, report the blocker explicitly and leave the working tree status clear in the final response.
- Do not include unrelated local changes in a task commit. Preserve user changes unless the user explicitly asks to modify or discard them.
