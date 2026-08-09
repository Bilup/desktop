# Bilup Desktop

Bilup Desktop is a free, open source desktop application for creating Scratch 3 projects. It is a mod of [TurboWarp](https://turbowarp.org/) (a faster, addon-packed Scratch mod built from the [MistWarp](https://warp.mistium.com/) project), with **total Chinese translations**, **live collaboration**, and more.

| | |
| --- | --- |
| Official website | <https://desktop.bilup.org/> |
| Repository | <https://github.com/Bilup/desktop> |
| Issues | <https://github.com/Bilup/desktop/issues> |
| License | [GPL-3.0](LICENSE) |

Bilup Desktop is a community-developed project and has **no affiliation with the Scratch Team or MIT**.

---

## Features

- **Live collaboration** — Work on the same project together in real time.
- **Total Chinese translations** — The entire editor is fully translated into Chinese (and more languages).
- **Bilup Nova** — Use AI agents to help you create projects.
- **Custom extensions library** — Browse and manage custom extensions inside the app.
- **Works offline** — Bilup extensions and library assets are bundled locally, no internet required.
- **Built-in packager** — Convert projects to HTML files or standalone applications for Windows, macOS, or Linux.
- **Hundreds of addons** — The full TurboWarp addon suite to customize and enhance your experience.
- **Native file support** — Open and save `.sb3`, `.sb2`, and `.sb` files directly from your file manager.
- **Automatic updates** — Get the latest version with built-in update checking.
- **Enhanced editor features** — Markdown support, shortcuts manager, window animations, crash-safe project saving, and warnings for blocks that are incompatible with TurboWarp.

## Download

The latest official releases can be downloaded from the [official website](https://desktop.bilup.org/).

Bilup Desktop is available for:

- **Windows 10 and later** — NSIS installer, portable executable, and Microsoft Store (AppX)
- **macOS** — Universal DMG (Apple Silicon + Intel), and Mac App Store
- **Linux** — Debian package (`.deb`), AppImage, `tar.gz`, and Snap

## Building from source

### Prerequisites

- [Git](https://git-scm.com/)
- [Node.js](https://nodejs.org/) 18 or newer (the CI uses Node 24)
- [npm](https://www.npmjs.com/)

> This guide assumes Linux or macOS. On Windows, replace the commands with their PowerShell equivalents.

### Quick start

```bash
# Clone the repository (including submodules)
git clone --recursive https://github.com/Bilup/desktop bilup-desktop
cd bilup-desktop

# Install dependencies
npm i

# Download the library files, packager, and prepare the extensions
npm run fetch

# Compile the renderer
npm run webpack:prod

# Package the app into an unpacked directory
npm run electron:package:dir
```

The last command outputs a `dist` directory. Open it in your file manager, enter the folder matching your platform (`mac`/`linux`/`windows`), and run the executable.

### Running in development

```bash
# Terminal 1: compile the renderer and watch for changes
npm run webpack:watch

# Terminal 2: launch the Electron app
npm run electron:start
```

### Notes

- Do not run `npm install` to add a **`package-lock.json`** to the repository.
- If the upstream repository changes, run `git pull` inside the cloned directory before rebuilding.
- Scripts that need network access can be tuned with environment variables, e.g. `TURBOWARP_EXTENSIONS_BASE_URL`.

## Project structure

| Path | Description |
| --- | --- |
| `src-main/` | Electron main process (windows, menus, settings, updates, protocols) |
| `src-preload/` | Electron preload scripts |
| `src-renderer/` | Static pages served by the app |
| `src-renderer-webpack/` | Renderer source compiled with webpack |
| `src-protocol-error/` | Error pages for custom protocols |
| `scripts/` | Fetch/build helper scripts |
| `release-automation/` | Scripts used to automate releasing new versions |
| `store-listings/` | Microsoft Store listing helpers |
| `docs/` | Source of the official website |
| `build/` | Packaging resources (icons, entitlements, etc.) |
| `art/` | Artwork |
| `debian/` | Debian packaging scripts |
| `linux-files/` | Extra Linux files (`.desktop` entry, MIME types) |

## Packaging installers

All release installers are produced by `release-automation/build.mjs`:

```bash
node release-automation/build.mjs --windows --production
```

Common flags: `--windows` / `--windows-portable` / `--microsoft-store` / `--mac` / `--debian` / `--appimage` / `--tarball`, optionally combined with `--x64` / `--arm64` / `--ia32` / `--universal`. Add `--production` to enable the update checker and production-only behavior. See `release-automation/README.md` for details.

## Changelog

See [changelog.md](changelog.md).

## Contributing

Contributions are welcome. If you find a bug or have a feature request, please open an issue at <https://github.com/Bilup/desktop/issues>. For security-related concerns, contact <support@bilup.org>.

## License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
