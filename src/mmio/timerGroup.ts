// ESP32 Timer Group (TIMERG0 / TIMERG1) as a memory-mapped device.
//
// Register map (ESP32 TRM, TIMERG0 base 0x3FF5F000, TIMERG1 base 0x3FF60000):
//   +0x00 T0CONFIG     +0x04 T0LO  +0x08 T0HI  +0x0C T0UPDATE  +0x10 T0ALARMLO …
//   +0x24 T1CONFIG …            (second general-purpose 64-bit timer, mirror of T0)
//   +0x48 WDTCONFIG0 …          (task watchdog)
//   +0x68 RTCCALICFG   +0x6C RTCCALICFG1   (RTC slow-clock calibration — TIMERG0 only)
//
// Most registers are a plain read/write register file (the watchdog/timer config the
// boot code programs but that we don't yet drive). The one piece with real behaviour
// needed to get past clock bring-up is the **RTC calibration counter** (TIMERG0): the
// clock code measures the ~150 kHz RC slow clock against the 40 MHz XTAL to learn the
// real slow-clock period. We model that counter exactly (count XTAL cycles over MAX
// slow-clock cycles) — instantaneously, since we don't burn the real microseconds — so
// the firmware reads a physically-consistent result instead of a hand-seeded magic bit.
//
// The general-purpose timer counters (T0/T1 → the FreeRTOS tick) are not driven yet;
// that lands with the system-timer step of M2.3.

import { MmioDevice } from "../cpu";

export const TIMERG0_BASE = 0x3ff5f000;
export const TIMERG1_BASE = 0x3ff60000;

// RTC calibration registers (offsets from the group base).
const RTCCALICFG = 0x68;
const RTCCALICFG1 = 0x6c;

// TIMG_RTCCALICFG_REG fields.
const CALI_START = 0x80000000;      // bit 31  — write 1 to launch a calibration
const CALI_MAX_SHIFT = 16;          // bits 30:16 — slow-clock cycles to count
const CALI_MAX_MASK = 0x7fff;
const CALI_RDY = 1 << 15;           // bit 15  — HW status: result ready (read-only to SW)
const CALI_CLK_SEL_SHIFT = 13;      // bits 14:13 — which slow clock to measure
const CALI_CLK_SEL_MASK = 0x3;

// TIMG_RTCCALICFG1_REG: VALUE in bits 31:7 (25-bit count), CYCLING_DATA_VLD in bit 0.
const CALI1_VALUE_SHIFT = 7;
const CALI1_VALUE_MASK = 0x01ffffff;
const CALI1_DATA_VLD = 1 << 0;

export interface TimerGroupOptions {
  /** Group base address (default TIMERG0). */
  base?: number;
  /** Reference clock the calibration counter runs on (default 40 MHz XTAL). */
  xtalFreqHz?: number;
  /** Only TIMERG0 carries the RTC calibration block; TIMERG1 does not. */
  hasRtcCali?: boolean;
}

export class TimerGroupDevice implements MmioDevice {
  readonly base: number;
  readonly size = 0x100;

  // Plain register file — registers hold what software writes (real, not a 0-returning
  // stub), except RTCCALICFG, whose RDY bit and paired result are owned by the counter.
  private readonly regs = new Map<number, number>();
  private readonly xtalFreqHz: number;
  private readonly hasRtcCali: boolean;

  constructor(opts: TimerGroupOptions = {}) {
    this.base = (opts.base ?? TIMERG0_BASE) >>> 0;
    this.xtalFreqHz = opts.xtalFreqHz ?? 40_000_000;
    this.hasRtcCali = opts.hasRtcCali ?? true;
  }

  read32(offset: number): number {
    return (this.regs.get(offset & ~3) ?? 0) >>> 0;
  }

  write32(offset: number, value: number): void {
    const off = offset & ~3;
    const v = value >>> 0;
    if (this.hasRtcCali && off === RTCCALICFG) {
      this.writeCaliCfg(v);
      return;
    }
    this.regs.set(off, v);
  }

  /** RTC calibration: software sets CLK_SEL + MAX, then arms START via a read-modify-
   *  write. On the START edge we run the count and publish the result + RDY immediately. */
  private writeCaliCfg(v: number): void {
    // RDY (bit 15) is hardware-owned; never let a software write set it directly.
    let cfg = v & ~CALI_RDY;
    if (v & CALI_START) {
      const max = (v >>> CALI_MAX_SHIFT) & CALI_MAX_MASK;
      const clkSel = (v >>> CALI_CLK_SEL_SHIFT) & CALI_CLK_SEL_MASK;
      const fSlow = slowClockHz(clkSel);
      // Cycles of the XTAL reference counted over `max` periods of the slow clock —
      // exactly what the silicon counter reports. f_slow ≈ 150 kHz → ~267 XTAL/cycle.
      const count = Math.round((max * this.xtalFreqHz) / fSlow) & CALI1_VALUE_MASK;
      this.regs.set(RTCCALICFG1, (((count << CALI1_VALUE_SHIFT) >>> 0) | CALI1_DATA_VLD) >>> 0);
      cfg = (cfg | CALI_RDY) >>> 0;
    }
    this.regs.set(RTCCALICFG, cfg >>> 0);
  }
}

/** Slow-clock frequency the calibration counter is measuring, per CLK_SEL field. */
function slowClockHz(clkSel: number): number {
  switch (clkSel) {
    case 1: return 31_250;    // internal 8 MHz RC oscillator / 256 (8MD256)
    case 2: return 32_768;    // external 32 kHz watch crystal
    default: return 150_000;  // RTC_MUX → internal ~150 kHz RC oscillator (boot default)
  }
}
