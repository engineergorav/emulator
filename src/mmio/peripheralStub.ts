// Logged no-op peripheral region (M2.1 boot-poke policy). ESP32 startup pokes dozens
// of config/status registers across the peripheral window (DPORT, RTC, clock, …) long
// before it reaches anything that lights an LED or prints. Hard-faulting on each would
// stall boot; modeling them all up front is wasted effort. So this device spans the
// whole peripheral window and answers reads with 0 / swallows writes — but RECORDS every
// distinct register touched (visible, not silent — R2), giving the worklist of registers
// that genuinely need behavior (those land as real devices, added BEFORE this catch-all).

import { MmioDevice } from "../cpu";

export const PERIPHERAL_BASE = 0x3ff00000;
export const PERIPHERAL_SIZE = 0x00080000; // 0x3FF00000 – 0x3FF80000

export class PeripheralStub implements MmioDevice {
  readonly base: number;
  readonly size: number;
  private readonly seenRead = new Set<number>();
  private readonly seenWrite = new Set<number>();
  // Registers whose read value matters (the boot-poke escape hatch — e.g. the RTC
  // XTAL-frequency store reg that startup asserts is non-zero). Writes update the seed.
  private readonly values = new Map<number, number>();

  /** Fired the first time a given register is read/written, for the boot probe + debugger. */
  onFirstAccess?: (addr: number, isWrite: boolean, value: number) => void;

  constructor(base = PERIPHERAL_BASE, size = PERIPHERAL_SIZE) {
    this.base = base >>> 0;
    this.size = size;
  }

  /** Pre-set a register's read value (absolute address) — for the few registers whose
   *  zero default would break boot (the bootloader normally programs them). */
  seed(addr: number, value: number): void {
    this.values.set(addr >>> 0, value >>> 0);
  }

  read32(offset: number): number {
    const addr = (this.base + offset) >>> 0;
    if (!this.seenRead.has(addr)) {
      this.seenRead.add(addr);
      this.onFirstAccess?.(addr, false, 0);
    }
    return this.values.get(addr) ?? 0;
  }

  write32(offset: number, value: number): void {
    const addr = (this.base + offset) >>> 0;
    if (!this.seenWrite.has(addr)) {
      this.seenWrite.add(addr);
      this.onFirstAccess?.(addr, true, value >>> 0);
    }
    // Writes are NOT stored back: most polled hardware registers (SPI/I2C command bits,
    // status flags) auto-clear, so a write-then-read must read 0. Registers that truly
    // need a non-zero read value are pre-set with seed() instead.
  }

  /** Sorted list of distinct registers accessed — the modeling worklist. */
  accessed(): { reads: number[]; writes: number[] } {
    const sort = (s: Set<number>) => [...s].sort((a, b) => a - b);
    return { reads: sort(this.seenRead), writes: sort(this.seenWrite) };
  }
}
