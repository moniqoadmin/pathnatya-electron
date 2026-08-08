# Pathnatya

Secure Electron desktop application with code protection and installer builds for **Windows and macOS laptops only**.

Phones, tablets, Linux, and other platforms are not supported. Installers are built for Windows (x64) and macOS (Intel + Apple Silicon). On Windows tablets/detachables the app exits at launch.

## Security Features

This app uses multiple layers to make source code difficult to access after installation:

| Layer | What it does |
|-------|--------------|
| **ASAR packaging** | Bundles app files into a single archive instead of loose source files |
| **JavaScript obfuscation** | Transforms code with control-flow flattening, string encryption, and self-defending wrappers |
| **No source maps** | Production builds strip `.map` files so original TypeScript cannot be recovered |
| **Electron fuses** | Hardens the binary: blocks Node.js mode, inspect flags, and validates ASAR integrity |
| **Sandbox + context isolation** | Renderer cannot access Node APIs directly |
| **DevTools disabled** | Developer tools are blocked in packaged builds |
| **Content protection** | Window is excluded from screen capture, so screen shares and recorders see the desktop behind it instead of the video |
| **Capture detection** | On Windows, any app holding an active screen-capture session is detected via the same data the OS privacy indicator uses (so browser and Snipping Tool recordings count too); screen recorders and remote-control apps are also matched by process name, installed Store recorders are discovered by package name and mapped to the executables they run as, and a keyword heuristic catches unknown recorders. Playback pauses and drops out of full screen until capture stops. Note: this is a best-effort deterrent — capture tools using legacy APIs may evade it, which is why content protection above is the real safeguard |

> **Note:** No desktop app can make code 100% impossible to reverse-engineer. This setup provides strong protection against casual extraction. For highly sensitive logic, keep it on a server.

## Prerequisites

- Node.js 20+
- npm 10+

**Mac builds:** You must build on macOS (or use a macOS CI runner). Windows cannot produce signed `.dmg` installers natively.

**Windows builds:** Build on Windows (or use a Windows CI runner).

## Development

```bash
npm install
npm run dev
```

## Build Installers

### Windows (.exe installer)

```bash
npm run dist:win
```

Output: `release/Pathnatya Setup 1.0.0.exe`

### macOS (.dmg)

```bash
npm run dist:mac
```

Output: `release/Pathnatya-1.0.0.dmg` (Intel + Apple Silicon)

### Both platforms

```bash
npm run dist:all
```

Requires running on each target OS, or use CI with matrix builds.

## Build Pipeline

```
npm run build    → Compile TypeScript/React with Vite (minified, no source maps)
npm run protect  → Obfuscate all JS in dist/ and remove source maps
electron-builder → Package ASAR + create platform installer + apply fuses
```

## Project Structure

```
src/
  main/       → Electron main process
  preload/    → Secure bridge between main and renderer
  renderer/   → React UI
scripts/
  protect.js  → Obfuscation pipeline
  after-pack.js → Electron fuse hardening
build/        → Icons and macOS entitlements
```

## Custom Icons

Replace placeholder icons before release:

- `build/icon.ico` — Windows
- `build/icon.icns` — macOS

## Code Signing (Recommended for Distribution)

For production distribution outside your organization:

- **Windows:** Sign with an Authenticode certificate
- **macOS:** Sign with an Apple Developer ID and notarize the app

Add signing config to `package.json` under the `build` section when certificates are available.
