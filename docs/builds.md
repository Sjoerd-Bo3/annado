# Getting test builds from GitHub

Desktop installers for **macOS** (universal), **Windows**, and **Linux** are
produced automatically by `.github/workflows/release.yml`. No local toolchain
needed to grab a build.

## For testers: download a release

1. Open the repo's **Releases** page.
2. Pick the latest version and download the installer for your OS:
   - macOS → `.dmg`
   - Windows → `*-setup.exe` (NSIS) or `.msi`
   - Linux → `.AppImage`, `.deb`, or `.rpm`

Releases are published automatically whenever a maintainer pushes a version
tag (see below).

### First launch (builds are currently unsigned)

Because the builds aren't code-signed yet, the OS will warn on first launch:

- **macOS:** right-click `Annado.app` ▸ **Open** (then confirm), or run
  `xattr -cr /Applications/Annado.app` once.
- **Windows:** on the SmartScreen prompt, click **More info ▸ Run anyway**.

Signing (Apple notarization, Windows Authenticode / Azure Trusted Signing) is
tracked as a follow-up in [`porting-plan.md`](./porting-plan.md).

## For maintainers

### Publish a release

```bash
# bump version in src-tauri/tauri.conf.json + package.json first, then:
git tag v0.1.0
git push origin v0.1.0
```

The workflow builds all three platforms and attaches the installers to a new
**pre-release** named `Annado v0.1.0`.

### Build a branch without releasing

GitHub ▸ **Actions** ▸ **Release** ▸ **Run workflow** ▸ pick a branch. The
installers are uploaded as downloadable **artifacts** on that workflow run
(nothing is published to the Releases page). Use this to hand a build to a
tester from any branch or PR.

## Notes

- macOS is built as a single **universal** binary (Apple Silicon + Intel).
- The fast `ci.yml` workflow (lint, tests, `cargo check` on all three OSes)
  still runs on every push/PR; `release.yml` only runs on tags and manual
  dispatch, so full installer builds don't slow down normal CI.
- iOS/iPadOS builds are **not** part of this pipeline — they require Apple
  signing and TestFlight; see [`ios.md`](./ios.md).
