#!/usr/bin/env node

/** Rebuild the macOS-only native permissions module for Electron. No-op on Windows. */
if (process.platform !== 'darwin') {
  process.exit(0)
}

const { execSync } = require('child_process')
const { existsSync } = require('fs')
const { join } = require('path')

if (!existsSync(join(__dirname, '..', 'node_modules', 'node-mac-permissions'))) {
  process.exit(0)
}

try {
  execSync('npx --yes @electron/rebuild -f -w node-mac-permissions', {
    cwd: join(__dirname, '..'),
    stdio: 'inherit'
  })
} catch {
  console.warn(
    '[rebuild-mac-permissions] Could not rebuild node-mac-permissions for Electron. Music / Photo Library prompts may not appear until it is rebuilt.'
  )
}
