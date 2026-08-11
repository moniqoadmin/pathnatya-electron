import { describe, expect, it } from 'vitest'
import { findWindowsGuestDriver, matchVirtualizationVendor } from './vm-guard'

describe('matchVirtualizationVendor', () => {
  it('names the hypervisor behind common guest firmware', () => {
    expect(matchVirtualizationVendor('VMware, Inc. | VMware20,1 | Phoenix Technologies LTD')).toBe(
      'VMware'
    )
    expect(matchVirtualizationVendor('innotek GmbH | VirtualBox | Oracle Corporation')).toBe(
      'VirtualBox'
    )
    expect(
      matchVirtualizationVendor('Parallels Software International Inc. | Parallels ARM Virtual Machine')
    ).toBe('Parallels')
    expect(matchVirtualizationVendor('QEMU | Standard PC (Q35 + ICH9, 2009) | SeaBIOS')).toBe('QEMU')
    expect(matchVirtualizationVendor('Xen | HVM domU | Xen 4.11')).toBe('Xen')
    expect(matchVirtualizationVendor('Microsoft Corporation | Virtual Machine | Hyper-V')).toBe(
      'Hyper-V'
    )
  })

  it('catches a guest whose only marker is the display adapter', () => {
    expect(
      matchVirtualizationVendor('Dell Inc. | OptiPlex 7090 | Dell Inc. | VirtualBox Graphics Adapter')
    ).toBe('VirtualBox')
    expect(matchVirtualizationVendor('. | . | . | Red Hat QXL controller')).toBe('QEMU')
  })

  it('recognises macOS guests', () => {
    expect(matchVirtualizationVendor('Model Identifier: VirtualMac2,1')).toBe(
      'Apple Virtualization'
    )
    expect(matchVirtualizationVendor('Model Identifier: VMware7,1')).toBe('VMware')
  })

  it('clears physical machines, including hosts with Hyper-V or VBS enabled', () => {
    expect(
      matchVirtualizationVendor('LENOVO | 20XW00ABUS | LENOVO | Intel(R) UHD Graphics')
    ).toBeNull()
    expect(matchVirtualizationVendor('Apple Inc. | MacBookPro18,3 | Apple M1 Pro')).toBeNull()
    expect(matchVirtualizationVendor('HP | HP EliteBook 840 G8 | NVIDIA GeForce RTX 3060')).toBeNull()
    expect(matchVirtualizationVendor('')).toBeNull()
  })
})

describe('findWindowsGuestDriver', () => {
  it('names the vendor of an installed guest-additions driver', () => {
    expect(findWindowsGuestDriver((path) => path.endsWith('VBoxMouse.sys'))).toBe('VirtualBox')
    expect(findWindowsGuestDriver((path) => path.endsWith('vm3dmp.sys'))).toBe('VMware')
    expect(findWindowsGuestDriver((path) => path.endsWith('prl_fs.sys'))).toBe('Parallels')
  })

  it('stays quiet when no guest driver is present', () => {
    expect(findWindowsGuestDriver(() => false)).toBeNull()
  })
})
