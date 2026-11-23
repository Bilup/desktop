This document is the authoritative source for Bilup's changelogs. Everything else gets generated from this list by `node scripts/generate-changelogs.mjs`.

Prefix notes with "Windows:", "macOS:", or "Linux:" as needed. Do not use **formatting** or [links](https://desktop.bilup.org/).

# 2.1.2 (2026-11-23)
- Updated the Settings feature (some addons have now been moved into Settings)
- Fixed a bug where font previews did not take effect
- Added a new feature: Performance Profiler
- Improved the styling of the Frosted Glass theme
- Improved the UI of some settings
- Optimized block palette performance
- Attempted to fix bugs in the "lazy loading of blocks" feature
- Fixed several other known issues

# 2.1.1 (2026-11-11)
- Fixed a memory leak that occurred when the frame rate exceeded 250
- Switched block rendering from DOM to canvas
- Removed the frame rate limit
- Added some missing English translations

# 2.1.0 (2026-11-08)

- Major update to the backpack, block count and variable manager addons
- Added the new "project-assets-manager" feature
- Added backpack animations
- Fixed several known issues
- Updated the packager from v1.4.0 to v1.5.0

# 2.0.12 (2026-10-30)

- Updated Electron to 43.8.4 with the latest security fixes
- Improved safety when loading extensions
- Linux: fixed missing window controls on Ubuntu 24.04 with Wayland

# 2.0.11 (2026-10-29)

- Bilup is now officially resuming updates.
- Fixed several serious issues
- Removed some settings that were no longer useful
- Added menu animations, and the menu now supports the "Frosted Glass Theme"
- Improved project saving speed

# 2.0.10 (2026-10-06)

- Routine maintenance release with stability improvements and small fixes

# 2.0.9 (2026-09-27)

- Updated the "Frosted Glass Theme"
- Updated the find bar and Spotlight
- Improved overall performance
- Fixed several known issues

# 2.0.8 (2026-09-21)

- Emergency fix for a critical issue: local assets could not be loaded

# 2.0.7 (2026-09-19)

- Major update for Git
- Fixed several issues with the "Frosted Glass Theme"
- Fixed several issues with the debugger
- Added "Custom addons"

# 2.0.6 (2026-09-17)

- Improved overall performance
- Fixed several known issues

# 2.0.5 (2026-09-13)

- Emergency fix for a critical issue: variable values were not updating in the editor
- Fixed several translation issues

# 2.0.4 (2026-09-07)

- Added the "Frosted Glass Theme"
- Fixed several theme-related issues
- Removed the "novatheai" addon

# 2.0.3 (2026-08-22)

- Fixed an issue where local settings could not be adjusted
- Fixed an issue related to the sandbox
- Added "Global custom block"
- Updated the styling of the sprite, costume, backdrop and sound selectors

# 2.0.2 (2026-08-15)

- Updated the "Custom Extensions Library"
- Emergency fix for several issues: custom fonts could not be used, and the "Windows Animations" setting could not be closed

# 2.0.1 (2026-08-12)

- Fixed extension libraries (Sharkpool) not working in local
- Fixed several translation issues
- Updated the extensions manager

# 2.0.0 (2026-08-09)

- Major update available: the new Bilup is ready for creating projects
- Fixed several known issues
- Improved overall performance

# 1.6.1 (2026-07-11)

- Emergency fix for a critical issue: the collaboration feature could not be used (regression from v1.6.0)
- Fixed several translation issues
- Fixed several known issues

# 1.6.0 (2026-07-10)

- Major update with a large batch of changes merged from MistWarp

# 1.5.4 (2026-07-05)

- Emergency fix for a critical issue: assets and extensions could not be loaded in the desktop app (regression from v1.5.2)
- Fixed several issues with live collaboration
- Updated window animations
- Added the "Custom Extensions Library"

# 1.5.3 (2026-06-24)

- Fixed several known issues
- Updated Markdown support
- Updated the shortcuts manager

# 1.5.2 (2026-06-09)

- Desktop: fixed extension libraries not working in local

# 1.5.1 (2026-06-05)

- Emergency fix for a critical issue: assets and extensions could not be loaded in the desktop app (regression from v1.5.0)

# 1.5.0 (2026-05-23)

- Fixed several known issues
- Bilup Nova is now available: AI agents can now help you create projects
- Added support for `api.yearnstudio.cn`

# 1.4.0 (2026-04-26)

- Bilup extensions are now available offline (no Internet connection required)
- Added warnings for blocks that are incompatible with TurboWarp
- Fixed several known issues, including in Git and the shortcuts manager
- Projects can now be saved after the editor crashes

# 1.3.0 (2026-04-13)

- Fixed several known issues and improved overall stability

# 1.2.0 (2026-04-03)

- Initial release after the desktop repository was cleaned up
