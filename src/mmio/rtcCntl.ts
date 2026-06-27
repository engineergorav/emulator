// ESP32 RTC controller (RTC_CNTL, base 0x3FF48000) as a memory-mapped device.
//
// Boot's clock bring-up leans on two RTC_CNTL features we model for real here:
//   • the 48-bit RTC timer (TIME0/TIME1 @ +0x10/+0x14, latched via TIME_UPDATE @ +0x70).
//     Firmware busy-waits like `t0 = rtc_time_get(); while (rtc_time_get() - t0 < n);`
//     — so the counter MUST advance, or the wait spins forever. We drive it from the
//     core's executed-cycle count (a real, monotonic time base), converted to the
//     ~150 kHz RTC slow clock, exactly like the silicon counter advancing in real time.
//   • the XTAL-frequency store register (STORE4 @ +0xB0), which the bootloader normally
//     programs and `rtc_clk_xtal_freq_get()` reads back (low16 == high16 == MHz).
//
// Everything else in the RTC_CNTL window is a plain read/write register file (the clock
// config / power / store registers boot programs but that we don't yet act on) — real
// registers that hold their values, not a 0-returning stub. Replaces the hand-seeded
// XTAL bit the boot probe used before this device existed.

import { MmioDevice } from "../cpu";

export const RTC_CNTL_BASE = 0x3ff48000;

// Register offsets (from the RTC_CNTL base).
const TIME_UPDATE = 0x0c;  // bit31 TIME_UPDATE (write 1 to latch), bit30 TIME_VALID (read)
const TIME0 = 0x10;        // RTC_CNTL_TIME0_REG — counter bits 31:0
const TIME1 = 0x14;        // RTC_CNTL_TIME1_REG — counter bits 47:32
const STORE4 = 0xb0;       // holds the XTAL frequency (read by rtc_clk_xtal_freq_get)

const TIME_UPDATE_BIT = 0x80000000; // bit 31 — request a counter latch
const TIME_VALID_BIT = 0x40000000;  // bit 30 — HW: latch complete, TIME0/1 readable

export interface RtcCntlOptions {
  /** Device base (default RTC_CNTL). */
  base?: number;
  /** Executed-CPU-cycle count — the time base the RTC counter is derived from. */
  now?: () => number;
  /** Nominal CPU clock the cycle count is rated at (default 240 MHz). */
  cpuHz?: number;
  /** RTC slow-clock frequency the counter runs on (default ~150 kHz RC). */
  rtcSlowHz?: number;
  /** XTAL frequency in MHz, stored in STORE4 (default 40). */
  xtalFreqMhz?: number;
}

export class RtcCntlDevice implements MmioDevice {
  readonly base: number;
  readonly size = 0x200;

  private readonly regs = new Map<number, number>();
  private readonly now: () => number;
  private readonly cpuHz: number;
  private readonly rtcSlowHz: number;
  private latched = 0n; // last latched 48-bit counter value

  constructor(opts: RtcCntlOptions = {}) {
    this.base = (opts.base ?? RTC_CNTL_BASE) >>> 0;
    this.now = opts.now ?? (() => 0);
    this.cpuHz = opts.cpuHz ?? 240_000_000;
    this.rtcSlowHz = opts.rtcSlowHz ?? 150_000;
    const xtal = (opts.xtalFreqMhz ?? 40) & 0xffff;
    this.regs.set(STORE4, (((xtal << 16) | xtal) >>> 0)); // low16 == high16 == MHz (valid marker)
  }

  /** RTC slow-clock ticks elapsed, derived from executed CPU cycles (real time base). */
  private counterNow(): bigint {
    const ticks = Math.floor((this.now() * this.rtcSlowHz) / this.cpuHz);
    return BigInt(ticks) & 0xffffffffffffn; // 48-bit counter
  }

  read32(offset: number): number {
    const off = offset & ~3;
    if (off === TIME0) return Number(this.latched & 0xffffffffn) >>> 0;
    if (off === TIME1) return Number((this.latched >> 32n) & 0xffffn) >>> 0;
    return (this.regs.get(off) ?? 0) >>> 0;
  }

  write32(offset: number, value: number): void {
    const off = offset & ~3;
    const v = value >>> 0;
    if (off === TIME_UPDATE) {
      if (v & TIME_UPDATE_BIT) {
        // Latch the live counter and flag it valid immediately (we don't model the
        // few slow-clock cycles the real latch takes — firmware only polls TIME_VALID).
        this.latched = this.counterNow();
        this.regs.set(TIME_UPDATE, ((v & ~TIME_UPDATE_BIT) | TIME_VALID_BIT) >>> 0);
      } else {
        this.regs.set(TIME_UPDATE, v);
      }
      return;
    }
    this.regs.set(off, v);
  }
}
