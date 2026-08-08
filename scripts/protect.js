/**
 * Post-build protection pipeline.
 * Obfuscates all JavaScript in dist/ before electron-builder packages the app.
 */
const fs = require('fs')
const path = require('path')
const { globSync } = require('glob')
const JavaScriptObfuscator = require('javascript-obfuscator')

const DIST_DIR = path.join(__dirname, '..', 'dist')

const OBFUSCATOR_OPTIONS = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.75,
  deadCodeInjection: true,
  deadCodeInjectionThreshold: 0.4,
  debugProtection: true,
  debugProtectionInterval: 4000,
  disableConsoleOutput: true,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: true,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 2,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 4,
  stringArrayWrappersType: 'function',
  stringArrayThreshold: 0.75,
  transformObjectKeys: true,
  unicodeEscapeSequence: false
}

function obfuscateFile(filePath) {
  const source = fs.readFileSync(filePath, 'utf8')
  const result = JavaScriptObfuscator.obfuscate(source, OBFUSCATOR_OPTIONS)
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
    ignore: ['**/*.min.js']
  })

  for (const file of jsFiles) {
    obfuscateFile(file)
  }

  console.log(`\nProtection complete. ${jsFiles.length} files obfuscated.`)
}

protectDist()
