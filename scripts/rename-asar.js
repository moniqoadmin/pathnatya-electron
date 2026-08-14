const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')

const UNIQUE_ASAR_NAME = 'pathnatya-7429163851048276.asar'

function getResourcesDirectory(context) {
  if (context.electronPlatformName === 'darwin') {
    const appName = context.packager.appInfo.productFilename
    return path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')
  }

  return path.join(context.appOutDir, 'resources')
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function createLauncherSource(expectedHash) {
  return `'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { app, dialog } = require('electron')

const APP_ASAR_NAME = ${JSON.stringify(UNIQUE_ASAR_NAME)}
const EXPECTED_SHA256 = ${JSON.stringify(expectedHash)}

function failIntegrityCheck(error) {
  const detail = error instanceof Error ? error.message : String(error)
  console.error('Pathnatya application integrity check failed:', detail)
  dialog.showErrorBox(
    'Pathnatya could not start',
    'The application files are missing or have been modified. Please reinstall Pathnatya.'
  )
  app.exit(1)
}

try {
  const appArchivePath = path.join(process.resourcesPath, APP_ASAR_NAME)
  const actualHash = crypto
    .createHash('sha256')
    .update(fs.readFileSync(appArchivePath))
    .digest()

  const expectedHash = Buffer.from(EXPECTED_SHA256, 'hex')
  if (
    actualHash.length !== expectedHash.length ||
    !crypto.timingSafeEqual(actualHash, expectedHash)
  ) {
    throw new Error('Archive checksum mismatch')
  }

  const appPackage = JSON.parse(
    fs.readFileSync(path.join(appArchivePath, 'package.json'), 'utf8')
  )

  if (typeof appPackage.main !== 'string' || appPackage.main.length === 0) {
    throw new Error('Packaged application entry point is invalid')
  }

  app.setAppPath(appArchivePath)
  require(path.join(appArchivePath, appPackage.main))
} catch (error) {
  failIntegrityCheck(error)
}
`
}

module.exports = async function renameApplicationAsar(context) {
  const resourcesDirectory = getResourcesDirectory(context)
  const standardAsarPath = path.join(resourcesDirectory, 'app.asar')
  const uniqueAsarPath = path.join(resourcesDirectory, UNIQUE_ASAR_NAME)
  const standardUnpackedPath = `${standardAsarPath}.unpacked`
  const uniqueUnpackedPath = `${uniqueAsarPath}.unpacked`

  if (!fs.existsSync(standardAsarPath)) {
    throw new Error(`Cannot rename ASAR: ${standardAsarPath} does not exist`)
  }

  fs.rmSync(uniqueAsarPath, { force: true })
  fs.rmSync(uniqueUnpackedPath, { recursive: true, force: true })
  fs.renameSync(standardAsarPath, uniqueAsarPath)

  if (fs.existsSync(standardUnpackedPath)) {
    fs.renameSync(standardUnpackedPath, uniqueUnpackedPath)
  }

  const launcherDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pathnatya-asar-launcher-')
  )

  try {
    fs.writeFileSync(
      path.join(launcherDirectory, 'package.json'),
      JSON.stringify({
        name: 'pathnatya-secure-launcher',
        version: context.packager.appInfo.version,
        private: true,
        main: 'index.js'
      })
    )
    fs.writeFileSync(
      path.join(launcherDirectory, 'index.js'),
      createLauncherSource(sha256(uniqueAsarPath))
    )

    await asar.createPackage(launcherDirectory, standardAsarPath)
  } finally {
    fs.rmSync(launcherDirectory, { recursive: true, force: true })
  }

  console.log(
    `Packaged application as ${UNIQUE_ASAR_NAME}; app.asar contains only the integrity launcher.`
  )
}
