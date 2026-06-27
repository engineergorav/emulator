// RiscVStubCore — NOT a working core. It exists only to prove, at compile time,
// that the `Cpu` interface is implementable by a second, totally different CPU
// (the expandability requirement: a future RISC-V ESP32-C3 drops in with zero
// rework of the board/UI layer — ADR-002, ENGINEERING_PRINCIPLES R1). Delete or
// replace when real RISC-V work begins.

import { Bus, Cpu } from "../cpu";

export class RiscVStubCore implements Cpu {
  readonly name = "riscv-stub";
  private readonly x = new Int32Array(32);
  private _pc = 0;
  private _cycles = 0;

  constructor(private readonly bus: Bus) {
    void this.bus;
  }

  reset(): void {
    this.x.fill(0);
    this._pc = 0;
    this._cycles = 0;
  }
  get pc(): number {
    return this._pc >>> 0;
  }
  set pc(v: number) {
    this._pc = v >>> 0;
  }
  get cycles(): number {
    return this._cycles;
  }
  readReg(index: number): number {
    return this.x[index & 31] | 0;
  }
  writeReg(index: number, value: number): void {
    if (index !== 0) this.x[index & 31] = value | 0; // x0 hardwired to 0
  }
  readMem(addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.bus.read8(addr + i);
    return out;
  }
  writeMem(addr: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) this.bus.write8(addr + i, data[i]);
  }
  step(): number {
    throw new Error("RiscVStubCore is a compile-time placeholder, not runnable");
  }
}
