// ESP32 GPIO peripheral (low bank, GPIO0–31) as a memory-mapped device.
//
// Register map (ESP32 TRM, GPIO base 0x3FF44000):
//   +0x04 GPIO_OUT          output value
//   +0x08 GPIO_OUT_W1TS     write-1-to-set bits of GPIO_OUT
//   +0x0C GPIO_OUT_W1TC     write-1-to-clear bits of GPIO_OUT
//   +0x20 GPIO_ENABLE       output enable (1 = pin drives)
//   +0x24 GPIO_ENABLE_W1TS
//   +0x28 GPIO_ENABLE_W1TC
//   +0x3C GPIO_IN           input value (driven by setInput, e.g. a button)
//
// On any write that changes OUT or ENABLE, the device recomputes each pin's driven
// level and fires `onOutput(pin, level)` for enabled pins whose level changed — that
// callback is what the browser wrapper routes to PinManager so an LED lights.
// GPIO32–39 (the high-bank OUT1/ENABLE1/IN1 regs) are not modeled yet.

import { MmioDevice } from "../cpu";

export const GPIO_BASE = 0x3ff44000;

const OUT = 0x04, OUT_W1TS = 0x08, OUT_W1TC = 0x0c;
const ENABLE = 0x20, ENABLE_W1TS = 0x24, ENABLE_W1TC = 0x28;
const IN = 0x3c;

export class GpioDevice implements MmioDevice {
  readonly base = GPIO_BASE;
  readonly size = 0x100;

  private out = 0;
  private enable = 0;
  private inReg = 0;
  private lastLevel: number[] = new Array(32).fill(-1); // -1 = hi-z/unknown

  /** Called for each enabled GPIO whose driven level changed (M1 → PinManager). */
  onOutput?: (pin: number, level: 0 | 1) => void;

  read32(offset: number): number {
    switch (offset) {
      case OUT: case OUT_W1TS: case OUT_W1TC: return this.out >>> 0;
      case ENABLE: case ENABLE_W1TS: case ENABLE_W1TC: return this.enable >>> 0;
      case IN: return this.inReg >>> 0;
      default: return 0;
    }
  }

  write32(offset: number, value: number): void {
    const v = value >>> 0;
    switch (offset) {
      case OUT: this.out = v; break;
      case OUT_W1TS: this.out = (this.out | v) >>> 0; break;
      case OUT_W1TC: this.out = (this.out & ~v) >>> 0; break;
      case ENABLE: this.enable = v; break;
      case ENABLE_W1TS: this.enable = (this.enable | v) >>> 0; break;
      case ENABLE_W1TC: this.enable = (this.enable & ~v) >>> 0; break;
      default: return; // unmodeled register — ignore
    }
    this.emitChanges();
  }

  /** Drive an input pin level (button/sensor → CPU). */
  setInput(pin: number, level: boolean): void {
    const bit = 1 << pin;
    if (level) this.inReg = (this.inReg | bit) >>> 0;
    else this.inReg = (this.inReg & ~bit) >>> 0;
  }

  private emitChanges(): void {
    for (let pin = 0; pin < 32; pin++) {
      const enabled = (this.enable >>> pin) & 1;
      const level = enabled ? ((this.out >>> pin) & 1) : -1;
      if (level !== this.lastLevel[pin]) {
        this.lastLevel[pin] = level;
        if (level >= 0 && this.onOutput) this.onOutput(pin, level as 0 | 1);
      }
    }
  }
}
