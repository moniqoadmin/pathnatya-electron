const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asar = require('@electron/asar')
const plist = require('plist')
const { NtExecutable, NtExecutableResource, Resource } = require('resedit')

const UNIQUE_ASAR_NAME = 'pathnatya-7429163851048276.asar'

function sha256(filePath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(filePath))
  return hash.digest('hex')
}

function asarHeaderIntegrity(filePath) {
  const { headerString } = asar.getRawHeader(filePath)
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(headerString).digest('hex')
  }
}

function updateMacIntegrity(context, integrity) {
  const infoPlistPath = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    '..',
    'Info.plist'
  )
  const infoPlist = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'))
  infoPlist.ElectronAsarIntegrity = integrity
  fs.writeFileSync(infoPlistPath, plist.build(infoPlist))
}

function updateWindowsIntegrity(context, integrity) {
  const executablePath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  )
  const executable = NtExecutable.from(fs.readFileSync(executablePath))
  const resource = NtExecutableResource.from(executable)
  const versionInfo = Resource.VersionInfo.fromEntries(resource.entries)

  if (versionInfo.length !== 1) {
    throw new Error(`Failed to read version information from ${executablePath}`)
  }

  const languages = versionInfo[0].getAllLanguagesForStringValues()
  if (languages.length !== 1) {
    throw new Error(`Failed to locate the executable language in ${executablePath}`)
  }

  resource.entries = resource.entries.filter(
    (entry) => !(entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')
  )

  const integrityList = Object.entries(integrity).map(
    ([file, { algorithm, hash }]) => ({
      file: path.win32.normalize(file),
      alg: algorithm,
      value: hash
    })
  )

  resource.entries.push({
    type: 'INTEGRITY',
    id: 'ELECTRONASAR',
    bin: Buffer.from(JSON.stringify(integrityList)),
    lang: languages[0].lang,
    codepage: languages[0].codepage
  })

  resource.outputResource(executable)
  fs.writeFileSync(executablePath, Buffer.from(executable.generate()))
}

function updateEmbeddedAsarIntegrity(
  context,
  standardAsarPath,
  uniqueAsarPath
) {
  const prefix = context.electronPlatformName === 'darwin' ? 'Resources' : ''
  const integrity = {
    [path.join(prefix, 'app.asar')]: asarHeaderIntegrity(standardAsarPath),
    [path.join(prefix, UNIQUE_ASAR_NAME)]: asarHeaderIntegrity(uniqueAsarPath)
  }

  if (context.electronPlatformName === 'darwin') {
    updateMacIntegrity(context, integrity)
  } else if (context.electronPlatformName === 'win32') {
    updateWindowsIntegrity(context, integrity)
  }
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
  const resourcesDirectory = context.packager.getResourcesDir(context.appOutDir)
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

  updateEmbeddedAsarIntegrity(context, standardAsarPath, uniqueAsarPath)

  console.log(
    `Packaged application as ${UNIQUE_ASAR_NAME}; app.asar contains only the integrity launcher.`
  )
}
