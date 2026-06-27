// The pluggable CPU boundary — the ONLY seam between an emulated core and the rest
// of the system (ENGINEERING_PRINCIPLES R1). `XtensaLX6Core` implements it now; a
// future `RiscVC3Core` drops in with zero changes to the board/UI layer.

/** A CPU core the emulator can drive. Cores know nothing about boards or UI. */
export interface Cpu {
  /** Stable id, e.g. "xtensa-lx6". */
  readonly name: string;

  /** Reset to power-on state (PC at the reset vector, registers cleared). */
  reset(): void;

  /** Execute exactly one instruction. Returns the number of cycles it consumed.
   *  Throws a NAMED error (never hangs silently — R2) on an opcode/MMIO it can't
   *  handle, so the wrapper can pause and surface the PC to the debugger. */
  step(): number;

  /** Program counter (byte address). Read for the debugger; written to jump. */
  pc: number;

  /** Cycles executed since the last reset. */
  readonly cycles: number;

  /** Register-file access for the debugger. Index space is core-specific. */
  readReg(index: number): number;
  writeReg(index: number, value: number): void;

  /** Linear memory access for the debugger + firmware loading. */
  readMem(addr: number, length: number): Uint8Array;
  writeMem(addr: number, data: Uint8Array): void;
}

/** Context handed to a High-Level-Emulation (HLE) hook — a JS stand-in for a function
 *  that lives in the chip's mask ROM. Instead of mapping the proprietary ROM blob and
 *  emulating everything it touches, the SoC layer registers a hook at the ROM function's
 *  address; the core intercepts the call, presents its arguments + return slot through
 *  this interface (the windowed-call ABI is already resolved), runs the hook, and returns
 *  to the caller. Keeps the ROM-licensing + peripheral surface out of scope (ADR-005). */
export interface HleContext {
  /** Argument register a[2+i] (i=0..5) of the intercepted call. */
  hookArg(i: number): number;
  /** Set the call's return value (a2). */
  hookReturn(value: number): void;
  /** Set a 64-bit return value (a2 = low, a3 = high) — libgcc long-long helpers. */
  hookReturn2(lo: number, hi: number): void;
  readMem(addr: number, length: number): Uint8Array;
  writeMem(addr: number, data: Uint8Array): void;
}

/** A single HLE ROM-function stand-in. */
export type HleHook = (ctx: HleContext) => void;

/** Memory + MMIO the core reads/writes. The core delegates ALL memory access here
 *  so it never imports a peripheral directly (R1). Little-endian (Xtensa + RISC-V). */
export interface Bus {
  read8(addr: number): number;
  read16(addr: number): number;
  read32(addr: number): number;
  write8(addr: number, value: number): void;
  write16(addr: number, value: number): void;
  write32(addr: number, value: number): void;
}

/** A memory-mapped peripheral occupying [base, base+size). Offsets are relative to
 *  `base`. M1 attaches GPIO here; M2/M3 attach the timer/UART/I2C/SPI/etc. */
export interface MmioDevice {
  readonly base: number;
  readonly size: number;
  /** 32-bit register read at `offset` (word-addressed peripherals). */
  read32(offset: number): number;
  /** 32-bit register write at `offset`. */
  write32(offset: number, value: number): void;
}

/** Thrown when the decoder hits an instruction it does not implement. Carries the
 *  PC so the wrapper can pause and point the debugger at it (R2). */
export class UnsupportedInstruction extends Error {
  constructor(
    readonly opcode: number,
    readonly at: number,
  ) {
    super(`unsupported instruction 0x${(opcode >>> 0).toString(16)} @ pc=0x${(at >>> 0).toString(16)}`);
    this.name = "UnsupportedInstruction";
  }
}

/** Thrown on access to an address that maps to neither RAM nor a known device. */
export class UnmappedAccess extends Error {
  constructor(
    readonly addr: number,
    readonly isWrite: boolean,
  ) {
    super(`unmapped ${isWrite ? "write" : "read"} @ 0x${(addr >>> 0).toString(16)}`);
    this.name = "UnmappedAccess";
  }
}

/** Thrown when a windowed CALL/ENTRY/RETW would overflow or underflow the register
 *  window — on real hardware these raise WindowOverflow/Underflow exceptions handled
 *  by the ROM vectors (register spill/fill to the stack). Until those vectors exist
 *  (M2), the core surfaces a named halt instead of a silent WINDOWBASE wrap (R2). */
export class WindowException extends Error {
  constructor(
    readonly kind: "overflow" | "underflow",
    readonly at: number,
  ) {
    super(`window ${kind} (spill/fill not yet modeled) @ pc=0x${(at >>> 0).toString(16)}`);
    this.name = "WindowException";
  }
}
