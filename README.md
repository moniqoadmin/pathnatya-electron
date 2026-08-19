# Pathnatya 2026

Secure Electron desktop app for **Pathnatya 2026** video access. Viewers sign in with a registered phone number on a single Windows or macOS laptop, then play a protected HLS video with device binding, content protection, and optional offline playback.

Phones, tablets, Linux, and other platforms are not supported. Installers are built for Windows (x64) and macOS (Intel + Apple Silicon). On Windows tablets and detachables the app exits at launch.

## Features

- Phone-number login with a one-time password that cannot be reset
- Device-bound sessions: video stays on the laptop used for the first login
- HLS playback with encrypted segments, custom player, scene markers, and a watermark
- First online login prepares the video on-device; later sessions can play without a full re-download
- Offline playback for eligible accounts, with periodic online check-in
- Automatic logout after 1 day
- Forced update when the server reports a newer app version
- Screen-capture and always-on-top detection, tamper scanning, and VM / clock-skew guards
- Tray mode, single-instance launch, and required OS permissions before use

## Supported platforms

| Platform | Installer | Architectures |
|----------|-----------|---------------|
| Windows 10/11 laptops | NSIS `.exe` | x64 |
| macOS | `.dmg` | Intel + Apple Silicon |

Minimum display size: **1280 × 720**.

## Tech stack

- **Electron 36** + **electron-vite**
- **React 19** + TypeScript
- **hls.js** for playback
- **sql.js** for local offline state
- **jose** for token handling
- **Vitest** for tests
- **electron-builder** for Windows and macOS installers

## Prerequisites

- Node.js 20+
- npm 10+

**Windows installers** must be built on Windows (or a Windows CI runner).

**macOS installers** must be built on macOS (or a macOS CI runner). Windows cannot produce signed `.dmg` files natively.

## Getting started

```bash
npm install
npm run dev
```

Other useful commands:

```bash
npm test              # Vitest
npm run typecheck     # TypeScript
npm run preview       # Preview a production renderer build
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm start` / `npm run dev` | Run the app in development |
| `npm test` | Run unit tests |
| `npm run typecheck` | Type-check without emitting files |
| `npm run build` | Compile main, preload, and renderer into `dist/` |
| `npm run protect` | Obfuscate production JS and strip source maps |
| `npm run dist:win` | Windows installer |
| `npm run dist:mac` | macOS installer |
| `npm run dist:all` | Both platforms (requires the matching OS or CI) |

## Build installers

```
npm run build    → Compile TypeScript/React (minified, no source maps)
npm run protect  → Obfuscate JS in dist/ and remove source maps
electron-builder → Package ASAR, create the installer, apply Electron fuses
```

### Windows

```bash
npm run dist:win
```

Output: `release/Pathnatya Setup 4.10.0.exe`

### macOS

```bash
npm run dist:mac
```

Output: `release/Pathnatya-4.10.0.dmg` (Intel + Apple Silicon)

### Both platforms

```bash
npm run dist:all
```

Run this on each target OS, or use a CI matrix.

## Project structure

```
src/
  main/       Electron main process (playback, guards, IPC)
  preload/    Isolated bridge between main and renderer
  renderer/   React UI
  shared/     Shared config and crypto helpers
scripts/
  protect.js       Post-build obfuscation
  rename-asar.js   ASAR rename after pack
build/            Icons and macOS entitlements
```

## Viewer flow

1. Grant required OS permissions (files/app storage, user folders, and Accessibility on macOS).
2. Continue past the guidelines, then enter a registered 10-digit phone number.
3. Set a password on first use (shown once, cannot be reset) or log in with the existing password.
4. Wait while the video is prepared on this device.
5. Watch in the protected player. A successful online login keeps access on this device for **7 days**. Video access ends after **15 August 2026**.

## Security

Production builds use several layers so installed source is harder to inspect:

| Layer | What it does |
|-------|--------------|
| ASAR packaging | Bundles app files into a single archive |
| JavaScript obfuscation | Transforms packaged JS before the installer is built |
| No source maps | Production builds strip `.map` files |
| Electron fuses | Blocks Node.js mode and inspect flags; validates ASAR integrity |
| Sandbox + context isolation | Renderer cannot call Node APIs directly |
| DevTools disabled | Developer tools are blocked in packaged builds |
| Content protection | The window is excluded from screen capture |
| Capture detection | Playback pauses while a capture session is active |

No desktop app can make reverse engineering impossible. This setup is a strong deterrent against casual extraction. Keep highly sensitive logic on the server.

## Icons

Replace placeholder icons before a public release:

- `build/icon.ico` — Windows
- `build/icon.icns` — macOS

## Code signing

For distribution outside your organization:

- **Windows:** Authenticode certificate
- **macOS:** Apple Developer ID signing and notarization

Add signing config to the `build` section of `package.json` when certificates are available.

## License

UNLICENSED. Private application; not for redistribution.
