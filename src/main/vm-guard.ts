import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export type VmVerdict = {
  virtual: boolean
  /** Display name of the hypervisor, e.g. "VMware". Empty when not virtual. */
  vendor: string
}

const NOT_VIRTUAL: VmVerdict = { virtual: false, vendor: '' }

/**
 * Strings that only appear on guest hardware. Matched against firmware, chassis and
 * display-adapter names — never against the process list, so a host that merely has
 * VMware or VirtualBox *installed* is not mistaken for a guest.
 *
 * Deliberately absent: Win32_ComputerSystem.HypervisorPresent and the CPUID
 * hypervisor bit. Both are set on ordinary Windows 11 machines that run Hyper-V,
 * WSL2, Docker Desktop, or memory integrity (VBS), which would block real users.
 */
const VENDOR_SIGNATURES: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /vmware/i, vendor: 'VMware' },
  { pattern: /virtualbox|vbox|innotek/i, vendor: 'VirtualBox' },
  { pattern: /parallels/i, vendor: 'Parallels' },
  { pattern: /qemu|bochs|\bqxl\b|virtio/i, vendor: 'QEMU' },
  { pattern: /\bkvm\b/i, vendor: 'KVM' },
  { pattern: /\bxen\b|hvm domu/i, vendor: 'Xen' },
  { pattern: /google compute engine/i, vendor: 'Google Compute Engine' },
  { pattern: /amazon ec2/i, vendor: 'Amazon EC2' },
  { pattern: /\bbhyve\b/i, vendor: 'bhyve' },
  { pattern: /nutanix/i, vendor: 'Nutanix AHV' },
  { pattern: /virtualmac|apple virtualization/i, vendor: 'Apple Virtualization' },
  { pattern: /hyper-?v/i, vendor: 'Hyper-V' },
  // Hyper-V, Windows Sandbox and Apple's VM framework report these chassis models.
  { pattern: /virtual machine|virtual platform/i, vendor: 'a virtual machine' }
]

/**
 * Guest-additions drivers. These ship with the guest tools installed *inside* a VM;
 * a host running VMware Workstation or VirtualBox gets vmci / vmnet / VBoxNetFlt
 * instead, which are not listed here.
 */
const WINDOWS_GUEST_DRIVERS: Array<{ file: string; vendor: string }> = [
  { file: 'VBoxMouse.sys', vendor: 'VirtualBox' },
  { file: 'VBoxGuest.sys', vendor: 'VirtualBox' },
  { file: 'VBoxSF.sys', vendor: 'VirtualBox' },
  { file: 'VBoxVideo.sys', vendor: 'VirtualBox' },
  { file: 'vmmouse.sys', vendor: 'VMware' },
  { file: 'vmhgfs.sys', vendor: 'VMware' },
  { file: 'vm3dmp.sys', vendor: 'VMware' },
  { file: 'vmusbmouse.sys', vendor: 'VMware' },
  { file: 'prl_fs.sys', vendor: 'Parallels' },
  { file: 'prl_tg.sys', vendor: 'Parallels' },
  { file: 'prl_mouse.sys', vendor: 'Parallels' },
  { file: 'netkvm.sys', vendor: 'QEMU' },
  { file: 'vioscsi.sys', vendor: 'QEMU' },
  { file: 'balloon.sys', vendor: 'QEMU' }
]

const PROBE_TIMEOUT_MS = 8000

/**
 * One line of firmware / chassis / display-adapter identity. wmic is deliberately
 * avoided: it is deprecated and no longer present on Windows 11 24H2 and later.
 */
const WINDOWS_PROBE_SCRIPT = [
  '$cs = Get-CimInstance Win32_ComputerSystem;',
  '$bios = Get-CimInstance Win32_BIOS;',
  '$gpu = @(Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name });',
  '$base = Get-CimInstance Win32_BaseBoard;',
  '@($cs.Manufacturer, $cs.Model, $bios.Manufacturer, $bios.SMBIOSBIOSVersion,',
  '$bios.SerialNumber, $base.Manufacturer, $base.Product, ($gpu -join " ")) -join " | "'
].join(' ')

let cachedVerdict: VmVerdict = NOT_VIRTUAL
let inflightDetection: Promise<VmVerdict> | null = null

/** Vendor behind the first virtualization marker in a hardware description. */
export function matchVirtualizationVendor(text: string): string | null {
  if (!text.trim()) {
    return null
  }

  return VENDOR_SIGNATURES.find((signature) => signature.pattern.test(text))?.vendor ?? null
}

/** Guest-additions driver present on disk, if any. */
export function findWindowsGuestDriver(
  fileExists: (path: string) => boolean = existsSync
): string | null {
  const driverDir = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'drivers')

  return (
    WINDOWS_GUEST_DRIVERS.find((driver) => fileExists(join(driverDir, driver.file)))?.vendor ?? null
  )
}

async function readProbe(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    })
    return stdout
  } catch {
    // A blocked or missing shell must not lock anyone out; other signals still apply.
    return ''
  }
}

async function probeWindows(): Promise<VmVerdict> {
  const hardware = await readProbe('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    WINDOWS_PROBE_SCRIPT
  ])

  const vendor = matchVirtualizationVendor(hardware) ?? findWindowsGuestDriver()
  return vendor ? { virtual: true, vendor } : NOT_VIRTUAL
}

async function probeMacOs(): Promise<VmVerdict> {
  // ioreg -l would work too but dumps megabytes; -rd1 on the platform node is enough.
  const [hypervisorFlag, hardware, platform] = await Promise.all([
    readProbe('sysctl', ['-n', 'kern.hv_vmm_present']),
    readProbe('system_profiler', ['SPHardwareDataType']),
    readProbe('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
  ])

  const vendor = matchVirtualizationVendor(`${hardware} ${platform}`)
  if (vendor) {
    return { virtual: true, vendor }
  }

  // Unlike Windows, this flag is only set inside a guest, so it stands on its own.
  if (hypervisorFlag.trim() === '1') {
    return { virtual: true, vendor: 'a virtual machine' }
  }

  return NOT_VIRTUAL
}

function probePlatform(): Promise<VmVerdict> {
  if (process.platform === 'win32') {
    return probeWindows()
  }

  if (process.platform === 'darwin') {
    return probeMacOs()
  }

  return Promise.resolve(NOT_VIRTUAL)
}

/**
 * Detects whether this process is running inside a virtual machine. Hardware identity
 * cannot change while the app is open, so the first verdict is cached and reused.
 */
export async function detectVirtualMachine(): Promise<VmVerdict> {
  inflightDetection ??= probePlatform().then((verdict) => {
    cachedVerdict = verdict
    return verdict
  })

  return inflightDetection
}

/** Last known verdict, for callers that cannot await (IPC handlers, protocol handler). */
export function getVirtualMachineVerdict(): VmVerdict {
  return cachedVerdict
}
