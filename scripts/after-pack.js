/**
 * Applies Electron fuses after packaging for additional hardening.
 * Disables running as Node, NODE_OPTIONS env, and inspect arguments.
 */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')

module.exports = async function afterPack(context) {
  const { electronPlatformName, appOutDir } = context
  const ext = electronPlatformName === 'darwin' ? '.app' : '.exe'
  const appName = context.packager.appInfo.productFilename

  let executablePath
  if (electronPlatformName === 'darwin') {
    executablePath = require('path').join(appOutDir, `${appName}.app`, 'Contents', 'MacOS', appName)
  } else if (electronPlatformName === 'win32') {
    executablePath = require('path').join(appOutDir, `${appName}${ext}`)
  } else {
    executablePath = require('path').join(appOutDir, appName)
  }

  await flipFuses(executablePath, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true
  })

  console.log(`Electron fuses applied: ${executablePath}`)
}
