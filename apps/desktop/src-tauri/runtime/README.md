# Bundled libmpv runtime

The desktop client links to libmpv and packages its runtime dependencies from
this directory. Runtime binaries are generated artifacts and are not committed.

Each supported target has a `lib` directory and a `manifest.sha256` file:

- `macos-aarch64`
- `windows-x86_64`
- `windows-aarch64`
- `linux-x86_64`
- `linux-aarch64`

For local macOS development, run `scripts/stage-macos-libmpv.sh`. Release jobs
must use the pinned, license-audited runtime build rather than a developer's
Homebrew installation.
