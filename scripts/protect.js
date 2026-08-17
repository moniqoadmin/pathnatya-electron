/**
 * Post-build protection pipeline.
 * Obfuscates JavaScript in dist/ before electron-builder packages the app.
 *
 * Main/preload get stronger protection (secrets / IPC surface).
 * Renderer gets light obfuscation only — heavy options like debugProtection /
 * selfDefending / deadCodeInjection cause severe UI lag on macOS Electron
 * (janky typing even on login), while adding little real security for UI code.
 */
const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const JavaScriptObfuscator = require('javascript-obfuscator')

const DIST_DIR = path.join(__dirname, '..', 'dist')

/** Shared safe defaults — never enable debugProtection / selfDefending in Electron. */
const BASE_OPTIONS = {
  compact: true,
  disableConsoleOutput: true,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  renameGlobals: false,
  simplify: true,
  // These fight DevTools auto-close and burn CPU on every frame / keystroke.
  debugProtection: false,
  selfDefending: false,
  unicodeEscapeSequence: false
}

/** Stronger protection for main process + preload (not on the hot UI path). */
const MAIN_PRELOAD_OPTIONS = {
  ...BASE_OPTIONS,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  numbersToExpressions: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 2,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true
}

/** Light protection for renderer — keep React responsive on macOS. */
const RENDERER_OPTIONS = {
  ...BASE_OPTIONS,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  numbersToExpressions: false,
  splitStrings: false,
  stringArray: true,
  stringArrayCallsTransform: false,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: false,
  stringArrayThreshold: 0.5,
  transformObjectKeys: false
}

function optionsForFile(filePath) {
  const relative = path.relative(DIST_DIR, filePath).split(path.sep).join('/')
  if (relative.startsWith('renderer/')) {
    return RENDERER_OPTIONS
  }
  return MAIN_PRELOAD_OPTIONS
}

function obfuscateFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const result = JavaScriptObfuscator.obfuscate(source, optionsForFile(filePath))
  fs.writeFileSync(filePath, result.getObfuscatedCode(), 'utf8')
  console.log(`Protected: ${path.relative(process.cwd(), filePath)}`)
}

function removeSourceMaps() {
  const mapFiles = globSync('**/*.map', { cwd: DIST_DIR, absolute: true })
  for (const mapFile of mapFiles) {
    fs.unlinkSync(mapFile)
    console.log(`Removed source map: ${path.relative(process.cwd(), mapFile)}`)
  }
}

function protectDist() {
  if (!fs.existsSync(DIST_DIR)) {
    console.error('dist/ not found. Run "npm run build" first.')
    process.exit(1)
  }

  removeSourceMaps()

  const jsFiles = globSync('**/*.js', {
    cwd: DIST_DIR,
    absolute: true,
    // sql-asm.js is generated Emscripten output — obfuscating it breaks SQLite.
    ignore: ['**/*.min.js', '**/vendor/**']
  })

  for (const file of jsFiles) {
    obfuscateFile(file)
  }

  console.log(`\nProtection complete. ${jsFiles.length} files obfuscated.`)
}

protectDist()
