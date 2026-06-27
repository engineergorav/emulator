// SystemBus — little-endian memory with optional MMIO device routing. Holds one or
// more RAM regions (the ESP32's DRAM/IRAM/flash-mapped ranges live far apart in the
// address space, so a single contiguous buffer would be multi-GB — M2 adds a region
// per area instead). The core talks only to this Bus, never to a peripheral directly (R1).

import { Bus, MmioDevice, UnmappedAccess } from "./cpu";

interface MemRegion {
  base: number;
  size: number;
  view: DataView;
}

export class SystemBus implements Bus {
  private readonly regions: MemRegion[] = [];
  private readonly devices: MmioDevice[] = [];

  constructor(ramBase: number, ramSize: number) {
    // Back-compat: the M0/M1 callers construct a single flat RAM region here. Pass
    // ramSize=0 to start empty and add regions explicitly (the M2 image loader).
    if (ramSize > 0) this.addRegion(ramBase, ramSize);
  }

  /** Add a backing RAM region [base, base+size). Regions must not overlap each other
   *  or a device range. Returns the bus for chaining. */
  addRegion(base: number, size: number): this {
    if (size > 0) {
      this.regions.push({ base: base >>> 0, size, view: new DataView(new ArrayBuffer(size)) });
    }
    return this;
  }

  /** True if [addr, addr+len) lies entirely within one RAM region (loader bounds check). */
  hasRegion(addr: number, len = 1): boolean {
    const r = this.regionFor(addr);
    return !!r && r.off + len <= r.region.size;
  }

  /** Attach a memory-mapped peripheral. Ranges must not overlap RAM. */
  addDevice(device: MmioDevice): void {
    this.devices.push(device);
  }

  private regionFor(addr: number): { region: MemRegion; off: number } | undefined {
    const a = addr >>> 0;
    for (const r of this.regions) {
      const off = a - r.base;
      if (off >= 0 && off < r.size) return { region: r, off };
    }
    return undefined;
  }

  private deviceFor(addr: number): MmioDevice | undefined {
    const a = addr >>> 0;
    return this.devices.find((d) => a >= d.base && a < d.base + d.size);
  }

  read8(addr: number): number {
    const m = this.regionFor(addr);
    if (m) return m.region.view.getUint8(m.off);
    const d = this.deviceFor(addr);
    if (d) return (d.read32((addr >>> 0) - d.base) >>> ((addr & 3) * 8)) & 0xff;
    throw new UnmappedAccess(addr, false);
  }

  read16(addr: number): number {
    const m = this.regionFor(addr);
    if (m && m.off + 2 <= m.region.size) return m.region.view.getUint16(m.off, true);
    return (this.read8(addr) | (this.read8(addr + 1) << 8)) & 0xffff;
  }

  read32(addr: number): number {
    const m = this.regionFor(addr);
    if (m && m.off + 4 <= m.region.size) return m.region.view.getUint32(m.off, true) >>> 0;
    const d = this.deviceFor(addr);
    if (d) return d.read32((addr >>> 0) - d.base) >>> 0;
    throw new UnmappedAccess(addr, false);
  }

  write8(addr: number, value: number): void {
    const m = this.regionFor(addr);
    if (m) {
      m.region.view.setUint8(m.off, value & 0xff);
      return;
    }
    throw new UnmappedAccess(addr, true); // byte writes to MMIO are rare; add when needed
  }

  write16(addr: number, value: number): void {
    const m = this.regionFor(addr);
    if (m && m.off + 2 <= m.region.size) {
      m.region.view.setUint16(m.off, value & 0xffff, true);
      return;
    }
    throw new UnmappedAccess(addr, true);
  }

  write32(addr: number, value: number): void {
    const m = this.regionFor(addr);
    if (m && m.off + 4 <= m.region.size) {
      m.region.view.setUint32(m.off, value >>> 0, true);
      return;
    }
    const d = this.deviceFor(addr);
    if (d) {
      d.write32((addr >>> 0) - d.base, value >>> 0);
      return;
    }
    throw new UnmappedAccess(addr, true);
  }
}
