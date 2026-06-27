// XtensaLX6Core — the classic-ESP32 CPU core (M0).
//
// Instruction length: op0 = word & 0xF. op0 >= 8 → 16-bit (density/narrow);
// otherwise 24-bit. Instruction word is little-endian on disk:
//   word = b0 | b1<<8 | b2<<16   (top byte unused for narrow forms).
// Field layouts were derived from the xtensa-esp32-elf toolchain (objdump) acting
// as the decode oracle — see docs/notes/xtensa-decode.md.
//
// Windowed registers: a0..a15 map to physical AR[(windowBase*4 + i) & 63]. Out of
// reset windowBase = 0, so a0..a15 == AR[0..15]. CALL/CALLX latch PS.CALLINC and stash
// the return address but do NOT rotate; ENTRY rotates windowBase by CALLINC; RETW
// unrotates. windowStart tracks live frames; a deep chain that would overflow/underflow
// the 64-register file raises a named WindowException (the spill/fill vectors are M2 —
// see ADR-004), never a silent wrap.

import { Bus, Cpu, HleContext, HleHook, UnsupportedInstruction, WindowException } from "../cpu";

const RESET_VECTOR = 0x40000000;
const AR_COUNT = 64;
const WIN_COUNT = AR_COUNT / 4; // 16 window positions (WindowBase is 0..15)

/** Sign-extend the low `bits` of `v`. */
function sext(v: number, bits: number): number {
  const shift = 32 - bits;
  return (v << shift) >> shift;
}

// Branch-immediate constant table (BEQI/BNEI/BLTI/BGEI). The 4-bit r field indexes
// this set of useful compare constants (note index 0 = -1, not 0).
const B4CONST = [-1, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];
// Unsigned variant (BLTUI/BGEUI) — differs only at indices 0/1.
const B4CONSTU = [32768, 65536, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16, 32, 64, 128, 256];

// Zero-overhead loop registers (LOOP/LOOPNEZ/LOOPGTZ). When PC reaches LEND with
// LCOUNT != 0, hardware silently jumps back to LBEG and decrements — no branch needed.
const SR_LBEG = 0;
const SR_LEND = 1;
const SR_LCOUNT = 2;

// Special-register numbers we give real behavior (the rest are store/return via `sr`).
const SR_SAR = 3;
const SR_SCOMPARE1 = 12; // compare value for the S32C1I atomic compare-and-swap
const SR_PS = 230; // processor state — INTLEVEL bits 3:0, EXCM bit 4, WOE bit 18
const SR_EPC1 = 177; // EPC[1] — PC a window/general exception returns to
const SR_VECBASE = 231; // exception vector base (set by wsr.vecbase early in boot)
const SR_PRID = 235; // ESP32: PRO_CPU reads 0xCDCD (bit 13 = 0), APP_CPU 0xABAB (bit 13 = 1)
const PRID_PRO_CPU = 0xcdcd;
const PRID_APP_CPU = 0xabab;

// PS fields used by the window spill/fill exceptions (M2.2).
const PS_EXCM = 1 << 4; // exception mode — window over/underflow detection is off while set
// Window exception vector offsets from VECBASE, indexed [overflow4, underflow4,
// overflow8, underflow8, overflow12, underflow12] — the standard Xtensa layout.
const VEC_WINDOW = [0x00, 0x40, 0x80, 0xc0, 0x100, 0x140];

// ROM code lives below IRAM (0x40000000–0x4006FFFF on the ESP32). A cheap range check
// gates the per-step hook lookup so the normal hot path pays nothing (R5).
const ROM_LO = 0x40000000;
const ROM_HI = 0x40070000;

export class XtensaLX6Core implements Cpu, HleContext {
  readonly name = "xtensa-lx6";

  private readonly ar = new Int32Array(AR_COUNT);
  private windowBase = 0;
  // WindowStart: one bit per window position marking a live call frame. Out of reset
  // frame 0 is live (bit 0 set). ENTRY sets the new frame's bit; RETW clears the
  // leaving frame's bit and checks the caller's is still set (else underflow).
  private windowStart = 1;
  // PS.CALLINC — the window increment (1/2/3) latched by the last windowed CALL/CALLX,
  // consumed by the callee's ENTRY to know how far to rotate. 0 after a call0/callx0.
  private callInc = 0;
  // Shift-amount register (set by SSL/SSR/SSAI, used by SLL/SRL/SRA) and the special
  // register file (RSR/WSR/XSR). Most SRs are plain storage at M2.1; SAR + PRID have
  // real behavior, and M2.2 will give PS/EPC/INTENABLE/CCOMPARE genuine semantics.
  private sar = 0;
  private readonly sr = new Int32Array(256);
  // HLE ROM-function hooks (address → JS stand-in). Populated by the SoC layer.
  private hooks: Map<number, HleHook> | null = null;
  private _pc = RESET_VECTOR;
  private _cycles = 0;
  // Window-exception bookkeeping (M2.2): the PC to re-execute after the spill/fill
  // handler returns, and the WindowBase to restore (PS.OWB). Set on exception entry,
  // consumed by RFWO/RFWU.
  private epc1 = 0;
  private psOwb = 0;

  // coreId 0 = PRO_CPU, 1 = APP_CPU (core 1). Drives PRID, which startup branches on.
  constructor(
    private readonly bus: Bus,
    private readonly coreId = 0,
  ) {}

  reset(): void {
    this.ar.fill(0);
    this.windowBase = 0;
    this.windowStart = 1;
    this.callInc = 0;
    this.sar = 0;
    this.sr.fill(0);
    this._pc = RESET_VECTOR;
    this._cycles = 0;
    this.epc1 = 0;
    this.psOwb = 0;
  }

  /** Special-register read (RSR/XSR). SAR + PRID modeled; the rest is plain storage. */
  private readSr(id: number): number {
    if (id === SR_SAR) return this.sar | 0;
    if (id === SR_PRID) return this.coreId === 0 ? PRID_PRO_CPU : PRID_APP_CPU;
    return this.sr[id & 0xff] | 0;
  }
  /** Special-register write (WSR/XSR). */
  private writeSr(id: number, v: number): void {
    if (id === SR_SAR) {
      this.sar = v & 0x3f;
      return;
    }
    this.sr[id & 0xff] = v | 0;
  }

  /** Window machine state — for the debugger (T4) and the M0 window-rotation tests. */
  windowState(): { windowBase: number; windowStart: number; callInc: number } {
    return { windowBase: this.windowBase, windowStart: this.windowStart, callInc: this.callInc };
  }

  /** Register HLE stand-ins for ROM functions, keyed by their ROM address (ADR-005).
   *  When PC reaches one, the core runs the hook instead of fetching from unmapped ROM. */
  installHooks(hooks: Map<number, HleHook>): void {
    this.hooks = hooks;
  }

  // HleContext — the hook reads args / sets the return through the (already-rotated)
  // call frame: a2..a7 hold the incoming arguments, a2 receives the return value.
  hookArg(i: number): number {
    return this.a(2 + i) | 0;
  }
  hookReturn(value: number): void {
    this.setA(2, value | 0);
  }
  hookReturn2(lo: number, hi: number): void {
    this.setA(2, lo | 0);
    this.setA(3, hi | 0);
  }

  /** Run an HLE ROM hook at `pc`: frame it like the callee's ENTRY+RETW would (rotate
   *  the window by the latched CALLINC so a2.. are the args, run the hook, then return
   *  to the address the windowed CALL stashed in a0). Works for call0/4/8/12 uniformly. */
  private runHook(pc: number, hook: HleHook): number {
    const owb = this.windowBase;
    this.windowBase = (this.windowBase + this.callInc) % WIN_COUNT; // as if ENTRY ran
    hook(this);
    const ret = ((pc & 0xc0000000) | (this.a(0) & 0x3fffffff)) >>> 0; // as if RETW ran
    this.windowBase = owb;
    this._cycles++;
    return ret;
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

  // Debugger reads/writes the *physical* AR file.
  readReg(index: number): number {
    return this.ar[index & (AR_COUNT - 1)] | 0;
  }
  writeReg(index: number, value: number): void {
    this.ar[index & (AR_COUNT - 1)] = value | 0;
  }

  readMem(addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = this.bus.read8(addr + i);
    return out;
  }
  writeMem(addr: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) this.bus.write8(addr + i, data[i]);
  }

  /** Windowed a-register read (a0..a15). */
  private a(i: number): number {
    return this.ar[(this.windowBase * 4 + i) & (AR_COUNT - 1)] | 0;
  }
  /** Windowed a-register write. */
  private setA(i: number, v: number): void {
    this.ar[(this.windowBase * 4 + i) & (AR_COUNT - 1)] = v | 0;
  }

  /** Shared body of CALL0/4/8/12 and CALLX0/4/8/12. Stashes the return address into
   *  the register that becomes the callee's a0 after ENTRY rotates (with the call
   *  increment `n` in its top 2 bits, so RETW knows how far to rotate back), latches
   *  PS.CALLINC, and returns the branch target. The window does NOT rotate here — the
   *  callee's ENTRY consumes CALLINC and rotates. Returns the next PC.
   *
   *  The window OVERFLOW check lives here (not in ENTRY) because the windowed CALL writes
   *  a[n*4] — the first register of the callee's frame — which, when the window is full,
   *  is still a live older frame's register. Detecting + spilling BEFORE that write keeps
   *  the spilled frame's a0 intact (the bug that motivated M2.2). This also covers HLE ROM
   *  calls: their CALLX spills first, so runHook's rotation never lands on live registers. */
  private call(n: number, pc: number, target: number): number {
    const ret = (pc + 3) >>> 0; // CALL / CALLX are 3 bytes
    if (n === 0) {
      this.setA(0, ret | 0); // call0/callx0 — non-windowed: a0 = full return addr
      this.callInc = 0;
      return target;
    }
    // Overflow if any of the n window groups the call rotates into is still a live frame.
    // (Skipped while in a handler — PS.EXCM — which itself does windowed spills.)
    if ((this.sr[SR_PS] & PS_EXCM) === 0) {
      const ws = this.windowStart & 0xffff;
      const ahead = (ws | (ws << WIN_COUNT)) >>> ((this.windowBase + 1) % WIN_COUNT);
      if ((ahead & ((1 << n) - 1)) !== 0) {
        return this.windowOverflow(pc); // spill the oldest frame, then re-execute this CALL
      }
    }
    this.setA(n * 4, ((n << 30) | (ret & 0x3fffffff)) | 0);
    this.callInc = n;
    return target;
  }

  /** Shared body of RETW (wide) and RETW.N. The current frame's a0 holds the call
   *  increment (top 2 bits) + the return PC (low 30, top 2 inherited from current PC).
   *  Rotate WindowBase back by that increment; if the caller's frame is no longer in
   *  registers (its WindowStart bit is clear → it was spilled), take a window UNDERFLOW
   *  exception to fill it from the stack, then re-execute (M2.2). Returns the next PC. */
  private retw(pc: number): number {
    const a0 = this.a(0);
    const inc = (a0 >>> 30) & 0x3;
    const retPc = ((pc & 0xc0000000) | (a0 & 0x3fffffff)) >>> 0;
    const owb = this.windowBase;
    const newBase = (owb - inc + WIN_COUNT) % WIN_COUNT;
    if ((this.windowStart & (1 << newBase)) === 0) {
      return this.windowUnderflow(pc, inc, newBase);
    }
    this.windowStart &= ~(1 << owb);
    this.windowBase = newBase;
    return retPc;
  }

  // ── Window spill/fill exceptions (M2.2) ───────────────────────────────────────
  // Real Xtensa firmware nests calls deeper than the 64-register file holds, so the
  // hardware raises a WindowOverflow on ENTRY (spill the oldest frame) and a
  // WindowUnderflow on RETW (fill the caller's frame). We vector to the firmware's own
  // _WindowOverflow{4,8,12}/_WindowUnderflow{4,8,12} handlers (loaded at VECBASE) — they
  // do the actual s32e/l32e moves and return with rfwo/rfwu — so the spill ABI is the
  // real one, not a re-implementation. (Supersedes the named-halt of ADR-004.)

  /** Highest a-register index an instruction reads/writes, for the window check. Returns
   *  a conservative upper bound (never under-counts a real access). Implicit a0 is always
   *  available; CALL's a[n*4] write is checked in call(), so CALL/J (pure-immediate forms)
   *  report 0 here. Registers are encoded in the r/s/t nibble fields. */
  private maxAccessedReg(op0: number, r: number, s: number, t: number, word: number): number {
    switch (op0) {
      case 0x5: return 0;                       // CALL — immediate target; a[n*4] via call()
      case 0x6: return ((word >> 4) & 0x3) === 0 ? 0 : s; // J = none; BZ/BI/ENTRY/LOOP use a[s]
      case 0x1: return t;                       // L32R
      case 0xb: return Math.max(r, s);          // ADDI.N
      case 0xc: return s;                       // MOVI.N / BEQZ.N / BNEZ.N — a[s]
      default: return Math.max(r, s, t);        // RRR / loads / stores / branches / narrows
    }
  }

  /** WindowOverflow entry: rotate WindowBase to the first live frame ahead (distance `n`)
   *  — that frame is the one being pushed out and spilled — and vector to the handler
   *  sized for *its* own width (the gap to the NEXT live frame: 4/8/12). Matches the
   *  Xtensa/QEMU algorithm: rotate by ctz(windowstart)+1, vector by ctz(windowstart>>n). */
  private windowOverflow(pc: number): number {
    const ws = this.windowStart & 0xffff;
    const shifted = (ws | (ws << WIN_COUNT)) >>> ((this.windowBase + 1) % WIN_COUNT);
    let n = 1;
    while (n < 15 && (shifted & (1 << (n - 1))) === 0) n++; // distance to the spill frame
    let c = 0;
    while (c < 2 && ((shifted >>> n) & (1 << c)) === 0) c++; // spill frame's size: 0/1/2
    this.enterWindowExc(pc, (this.windowBase + n) % WIN_COUNT);
    return (this.vecBase() + VEC_WINDOW[c * 2]) >>> 0;
  }

  /** WindowUnderflow entry: `n` is the returning frame's call increment, `fillBase` the
   *  caller's WindowBase. Rotate to the caller's frame and jump to its underflow vector. */
  private windowUnderflow(pc: number, n: number, fillBase: number): number {
    this.enterWindowExc(pc, fillBase);
    return (this.vecBase() + VEC_WINDOW[(n - 1) * 2 + 1]) >>> 0;
  }

  private enterWindowExc(pc: number, handlerBase: number): void {
    this.epc1 = pc >>> 0;
    this.psOwb = this.windowBase;        // PS.OWB — restored by RFWO/RFWU
    this.sr[SR_PS] |= PS_EXCM;
    this.windowBase = handlerBase;       // handler sees the spill/fill frame as a0..
  }

  private vecBase(): number {
    return this.sr[SR_VECBASE] >>> 0;
  }

  step(): number {
    let pc = this._pc >>> 0;
    // Zero-overhead loop: reaching LEND with a live LCOUNT jumps back to LBEG (no branch
    // instruction at the bottom of the loop). LCOUNT != 0 gates the check off the hot path.
    if (this.sr[SR_LCOUNT] !== 0 && pc === (this.sr[SR_LEND] >>> 0)) {
      this.sr[SR_LCOUNT] = (this.sr[SR_LCOUNT] - 1) | 0;
      pc = this.sr[SR_LBEG] >>> 0;
      this._pc = pc;
    }
    // HLE ROM call: if PC entered the ROM range and a stand-in is registered, run it
    // instead of fetching from the (unmapped) mask ROM, then return to the caller.
    if (this.hooks !== null && pc >= ROM_LO && pc < ROM_HI) {
      const hook = this.hooks.get(pc);
      if (hook) {
        this._pc = this.runHook(pc, hook);
        return 1;
      }
    }
    const b0 = this.bus.read8(pc);
    const op0 = b0 & 0xf;
    const narrow = op0 >= 8;
    const len = narrow ? 2 : 3;

    const word = narrow
      ? b0 | (this.bus.read8(pc + 1) << 8)
      : b0 | (this.bus.read8(pc + 1) << 8) | (this.bus.read8(pc + 2) << 16);

    // common sub-fields
    const t = (word >> 4) & 0xf;
    const s = (word >> 8) & 0xf;
    const r = (word >> 12) & 0xf;

    // Window check (M2.2): accessing a high a-register (a4..a15) that physically belongs
    // to a live OLDER frame must spill that frame first — on real Xtensa the register
    // access itself raises WindowOverflow. We compute the highest a-register this
    // instruction touches and, if it lies beyond the available window, vector to the
    // spill handler and re-execute. (CALL handles its own a[n*4] write in call(); window
    // handlers run with PS.EXCM set, which disables the check so their s32e/l32e can reach
    // the spill frame.) This is the access-level analogue of the call-time overflow check.
    if ((this.sr[SR_PS] & PS_EXCM) === 0) {
      const maxReg = this.maxAccessedReg(op0, r, s, t, word);
      if (maxReg >= 4) {
        const ws = this.windowStart & 0xffff;
        const ahead = (ws | (ws << WIN_COUNT)) >>> ((this.windowBase + 1) % WIN_COUNT);
        let d = 1;
        while (d < 4 && (ahead & (1 << (d - 1))) === 0) d++;
        if (maxReg >= d * 4) { // available window = d*4 registers (d = groups to next frame)
          this._pc = this.windowOverflow(pc);
          return 1;
        }
      }
    }

    let nextPc = (pc + len) >>> 0;
    this._cycles++;

    switch (op0) {
      case 0x0: {
        // RRR (QRST) group. op1 = bits[23:20] (sub-op), op2 = bits[19:16] (group).
        const op1 = (word >> 20) & 0xf;
        const op2 = (word >> 16) & 0xf;
        if (op2 === 0x0 && op1 === 0x0) {
          // RST0 / op1=0 sub-group: r selects. r=0 → SNM0 (RET/RETW/JX/CALLX);
          // r=1 → MOVSP; r=2 → SYNC group (ISYNC/RSYNC/MEMW/EXTW/NOP — all barriers,
          // no architectural effect in an in-order interpreter).
          if (r === 0x2) break;
          if (r === 0x6) {
            // RSIL a[t], level — read PS into a[t], set PS.INTLEVEL (bits 3:0) = s.
            // No interrupts until M2.2, so this just stores the level; the read value
            // matters for the matching WSR.PS that restores it (critical sections).
            const old = this.readSr(SR_PS);
            this.setA(t, old);
            this.writeSr(SR_PS, (old & ~0xf) | (s & 0xf));
            break;
          }
          if (r === 0x1) {
            // MOVSP a[t], a[s] — a window-checked stack-pointer move. The spill/fill
            // (ALLOCA) path needs the M2 exception vectors; for the non-spilling case
            // it is a plain copy, which is exactly what executes when no frame was
            // spilled (the only regime M0 supports — deeper chains hit the window
            // overflow guard below first).
            this.setA(t, this.a(s));
            break;
          }
          if (r === 0x3) {
            // RFE-family (s selects). RFWO (s=4) / RFWU (s=5): return from a window
            // overflow/underflow handler. Fix up the spilled/filled frame's WindowStart
            // bit, restore WindowBase from PS.OWB, leave exception mode, and resume at
            // EPC1 (re-executing the ENTRY/RETW that faulted — now it succeeds).
            if (s === 0x4 || s === 0x5) {
              if (s === 0x4) this.windowStart &= ~(1 << this.windowBase); // RFWO: frame spilled
              else this.windowStart |= 1 << this.windowBase;              // RFWU: frame filled
              this.windowBase = this.psOwb;
              this.sr[SR_PS] &= ~PS_EXCM;
              nextPc = this.epc1 >>> 0;
              break;
            }
            throw new UnsupportedInstruction(word, pc);
          }
          if (r === 0x0) {
            const m = (word >> 6) & 0x3;
            const nn = (word >> 4) & 0x3;
            if (m === 0x2) {
              if (nn === 0x0) { nextPc = this.a(0) >>> 0; break; }   // RET  → pc = a0
              if (nn === 0x1) { nextPc = this.retw(pc); break; }     // RETW
              if (nn === 0x2) { nextPc = this.a(s) >>> 0; break; }   // JX   → pc = a[s]
            }
            // CALLX0/4/8/12 — read the target a[s] BEFORE call() stashes the return
            // address, since a[n*4] may alias the target register (e.g. callx8 a8).
            if (m === 0x3) { nextPc = this.call(nn, pc, this.a(s) >>> 0); break; }
          }
          throw new UnsupportedInstruction(word, pc);
        }
        if (op2 === 0x0) {
          // ALU / logic group, dispatched by op1.
          switch (op1) {
            case 0x1: this.setA(r, this.a(s) & this.a(t)); break;             // AND
            case 0x2: this.setA(r, this.a(s) | this.a(t)); break;             // OR
            case 0x3: this.setA(r, this.a(s) ^ this.a(t)); break;             // XOR
            case 0x8: this.setA(r, (this.a(s) + this.a(t)) | 0); break;       // ADD
            case 0x9: this.setA(r, (2 * this.a(s) + this.a(t)) | 0); break;   // ADDX2 = (as<<1)+at
            case 0xa: this.setA(r, (4 * this.a(s) + this.a(t)) | 0); break;   // ADDX4 = (as<<2)+at
            case 0xb: this.setA(r, (8 * this.a(s) + this.a(t)) | 0); break;   // ADDX8 = (as<<3)+at
            case 0xc: this.setA(r, (this.a(s) - this.a(t)) | 0); break;       // SUB
            case 0x4: // shift-amount / misc group (RST0): r selects SSR / SSL / SSAI / NSAU
              if (r === 0x0) this.sar = this.a(s) & 0x1f;                      // SSR (right)
              else if (r === 0x1) this.sar = (32 - (this.a(s) & 0x1f)) & 0x3f; // SSL (left)
              else if (r === 0x2) this.sar = (this.a(s) & 3) << 3;             // SSA8L (unaligned LE)
              else if (r === 0x3) this.sar = (32 - ((this.a(s) & 3) << 3)) & 0x3f; // SSA8B (unaligned BE)
              else if (r === 0x4) this.sar = (((t & 1) << 4) | s) & 0x3f;      // SSAI (immediate)
              else if (r === 0xf) this.setA(t, Math.clz32(this.a(s) >>> 0));   // NSAU (count leading 0s)
              else throw new UnsupportedInstruction(word, pc);
              break;
            case 0x6: // NEG (s=0) / ABS (s=1): a[r] = -a[t] / |a[t]|
              this.setA(r, s === 0 ? -this.a(t) | 0 : Math.abs(this.a(t)) | 0);
              break;
            case 0x5: // MMU/MPU TLB ops — no TLB modeled (segments pre-mapped, ADR-005).
              // r 4/6/C/E = invalidate/write ITLB/DTLB → no-op; r 3/5/7/B/D/F = probe/read → 0.
              if (r !== 0x4 && r !== 0x6 && r !== 0xc && r !== 0xe) this.setA(t, 0);
              break;
            default: throw new UnsupportedInstruction(word, pc);
          }
          break;
        }
        if (op2 === 0x1) {
          // Shift group. SLLI shifts a[s]; SRLI/SRAI shift a[t] (Xtensa quirk).
          if (op1 === 0x0 || op1 === 0x1) {
            const sa = 32 - (((op1 & 1) << 4) | t); // SLLI: encoded value = 32-sa
            this.setA(r, this.a(s) << (sa & 31));
            break;
          }
          if (op1 === 0x2 || op1 === 0x3) {
            const sa = ((op1 & 1) << 4) | t; // SRAI
            this.setA(r, this.a(t) >> (sa & 31));
            break;
          }
          if (op1 === 0x4) {
            this.setA(r, this.a(t) >>> (s & 0xf)); // SRLI (sa = s field, 0..15)
            break;
          }
          if (op1 === 0x6) { // XSR.* — atomic swap of a[t] and special register
            const id = (word >> 8) & 0xff;
            const tmp = this.a(t);
            this.setA(t, this.readSr(id));
            this.writeSr(id, tmp);
            break;
          }
          if (op1 === 0x8) { // SRC — funnel-shift the 64-bit (a[s]:a[t]) right by SAR
            const sa = this.sar & 0x1f;
            const hi = this.a(s), lo = this.a(t);
            this.setA(r, sa === 0 ? lo : ((hi << (32 - sa)) | (lo >>> sa)) | 0);
            break;
          }
          if (op1 === 0x9) { this.setA(r, this.a(t) >>> (this.sar & 0x1f)); break; } // SRL
          if (op1 === 0xa) { // SLL: a[r] = a[s] << (32 - SAR); SAR=0 ⇒ shift 32 ⇒ 0
            const sh = (32 - (this.sar & 0x3f)) & 0x3f;
            this.setA(r, sh >= 32 ? 0 : this.a(s) << sh);
            break;
          }
          if (op1 === 0xb) { this.setA(r, this.a(t) >> (this.sar & 0x1f)); break; } // SRA
          throw new UnsupportedInstruction(word, pc);
        }
        if (op2 === 0x2) {
          // RST2 — 32-bit multiply + integer divide/remainder. (Div-by-zero raises an
          // exception on HW (M2.2); we produce 0 for now — __utoa etc. never divide by 0.)
          const as2 = this.a(s), at2 = this.a(t);
          switch (op1) {
            case 0x8: this.setA(r, Math.imul(as2, at2)); break;                    // MULL (low 32)
            case 0xa: this.setA(r, Number(((BigInt(as2 >>> 0) * BigInt(at2 >>> 0)) >> 32n) & 0xffffffffn) | 0); break; // MULUH
            case 0xb: this.setA(r, Number(((BigInt(as2) * BigInt(at2)) >> 32n) & 0xffffffffn) | 0); break;             // MULSH
            case 0xc: this.setA(r, at2 === 0 ? 0 : ((as2 >>> 0) / (at2 >>> 0)) | 0); break; // QUOU
            case 0xd: this.setA(r, at2 === 0 ? 0 : (as2 / at2) | 0); break;        // QUOS
            case 0xe: this.setA(r, at2 === 0 ? 0 : ((as2 >>> 0) % (at2 >>> 0)) | 0); break; // REMU
            case 0xf: this.setA(r, at2 === 0 ? 0 : (as2 % at2) | 0); break;        // REMS
            default: throw new UnsupportedInstruction(word, pc);
          }
          break;
        }
        if (op2 === 0x3) {
          // RST3 group, dispatched by op1: special-reg access, min/max, sext, and the
          // conditional moves. (sr id = bits[15:8] for RSR/WSR.)
          const as3 = this.a(s), at3 = this.a(t);
          switch (op1) {
            case 0x0: this.setA(t, this.readSr((word >> 8) & 0xff)); break;       // RSR.*
            case 0x1: this.writeSr((word >> 8) & 0xff, this.a(t)); break;         // WSR.*
            case 0x2: this.setA(r, sext(as3, t + 8)); break;                      // SEXT (bit t+7)
            case 0x4: this.setA(r, (as3 < at3 ? as3 : at3) | 0); break;           // MIN
            case 0x5: this.setA(r, (as3 > at3 ? as3 : at3) | 0); break;           // MAX
            case 0x6: this.setA(r, ((as3 >>> 0) < (at3 >>> 0) ? as3 : at3) | 0); break; // MINU
            case 0x7: this.setA(r, ((as3 >>> 0) > (at3 >>> 0) ? as3 : at3) | 0); break; // MAXU
            case 0x8: if (at3 === 0) this.setA(r, as3); break;                    // MOVEQZ
            case 0x9: if (at3 !== 0) this.setA(r, as3); break;                    // MOVNEZ
            case 0xa: if (at3 < 0) this.setA(r, as3); break;                      // MOVLTZ
            case 0xb: if (at3 >= 0) this.setA(r, as3); break;                     // MOVGEZ
            default: throw new UnsupportedInstruction(word, pc);
          }
          break;
        }
        if (op2 === 0x4 || op2 === 0x5) {
          // EXTUI a[r], a[t], shiftimm, maskimm — zero-extended bitfield extract.
          // shiftimm[4] is op2's low bit; maskimm (numbits-1) is op1; src=t, dst=r.
          const shift = (((op2 & 1) << 4) | s) & 0x1f;
          const mask = ((1 << (op1 + 1)) - 1) >>> 0;
          this.setA(r, (this.a(t) >>> shift) & mask);
          break;
        }
        if (op2 === 0x9) {
          // Windowed spill/fill memory ops — used only inside the window exception
          // handlers. offset = (r − 16) × 4 (range −64..−4, into the stack save area).
          // L32E (op1=0): a[t] = mem32[a[s]+off];  S32E (op1=4): mem32[a[s]+off] = a[t].
          const addr = (this.a(s) + (r - 16) * 4) >>> 0;
          if (op1 === 0x0) { this.setA(t, this.bus.read32(addr) | 0); break; }
          if (op1 === 0x4) { this.bus.write32(addr, this.a(t) >>> 0); break; }
          throw new UnsupportedInstruction(word, pc);
        }
        throw new UnsupportedInstruction(word, pc);
      }

      case 0x1: {
        // L32R  a[t] = mem32[((pc+3)&~3) + (imm16<<2) - 0x40000]  (literal pool, neg offset)
        const imm16 = (word >> 8) & 0xffff;
        const vaddr = (((pc + 3) & 0xfffffffc) + ((imm16 << 2) - 0x40000)) >>> 0;
        this.setA(t, this.bus.read32(vaddr) | 0);
        break;
      }

      case 0x2: {
        // RRI8 group: r selects op. imm8 = bits[23:16].
        const imm8 = (word >> 16) & 0xff;
        switch (r) {
          case 0x0: // L8UI  a[t] = mem8[a[s] + imm8]
            this.setA(t, this.bus.read8((this.a(s) + imm8) >>> 0) & 0xff);
            break;
          case 0x1: // L16UI  a[t] = mem16[a[s] + (imm8<<1)]  (zero-extended)
            this.setA(t, this.bus.read16((this.a(s) + (imm8 << 1)) >>> 0) & 0xffff);
            break;
          case 0x2: // L32I  a[t] = mem32[a[s] + (imm8<<2)]
            this.setA(t, this.bus.read32((this.a(s) + (imm8 << 2)) >>> 0) | 0);
            break;
          case 0x4: // S8I  mem8[a[s] + imm8] = a[t]
            this.bus.write8((this.a(s) + imm8) >>> 0, this.a(t) & 0xff);
            break;
          case 0x5: // S16I  mem16[a[s] + (imm8<<1)] = a[t]
            this.bus.write16((this.a(s) + (imm8 << 1)) >>> 0, this.a(t) & 0xffff);
            break;
          case 0x6: // S32I  mem32[a[s] + (imm8<<2)] = a[t]
            this.bus.write32((this.a(s) + (imm8 << 2)) >>> 0, this.a(t));
            break;
          case 0x9: // L16SI  a[t] = mem16[a[s] + (imm8<<1)]  (sign-extended)
            this.setA(t, sext(this.bus.read16((this.a(s) + (imm8 << 1)) >>> 0), 16));
            break;
          case 0xe: { // S32C1I — atomic compare-and-swap vs SCOMPARE1 (single-core: just atomic)
            const addr = (this.a(s) + (imm8 << 2)) >>> 0;
            const old = this.bus.read32(addr) | 0;
            if (old === (this.sr[SR_SCOMPARE1] | 0)) this.bus.write32(addr, this.a(t));
            this.setA(t, old);
            break;
          }
          case 0xa: { // MOVI  a[t] = sext12((s<<8) | imm8)
            const imm12 = ((s << 8) | imm8) & 0xfff;
            this.setA(t, sext(imm12, 12));
            break;
          }
          case 0xc: // ADDI  a[t] = a[s] + sext8(imm8)
            this.setA(t, (this.a(s) + sext(imm8, 8)) | 0);
            break;
          case 0xd: // ADDMI  a[t] = a[s] + (sext8(imm8) << 8)  (large-constant add)
            this.setA(t, (this.a(s) + (sext(imm8, 8) << 8)) | 0);
            break;
          default:
            throw new UnsupportedInstruction(word, pc);
        }
        break;
      }

      case 0x5: {
        // CALL format. n = bits[5:4] (0/1/2/3 → call0/4/8/12); offset = sext18(bits[23:6]),
        // a WORD offset from the next aligned PC: target = ((pc & ~3) + 4) + (offset<<2).
        const n = (word >> 4) & 0x3;
        const offset = sext((word >> 6) & 0x3ffff, 18);
        const target = (((pc & 0xfffffffc) + 4) + (offset << 2)) >>> 0;
        nextPc = this.call(n, pc, target);
        break;
      }

      case 0x6: {
        // CALL/J/BZ group. n = bits[5:4].
        const n = (word >> 4) & 0x3;
        if (n === 0x0) {
          const imm18 = (word >> 6) & 0x3ffff;
          nextPc = (pc + 4 + sext(imm18, 18)) >>> 0; // J
          break;
        }
        if (n === 0x3 && ((word >> 6) & 0x3) === 0x0) {
          // ENTRY a[s], imm — windowed-call prologue. Rotates WindowBase by the CALLINC
          // the caller set, marks the new frame live, and writes the new stack pointer
          // (old a[s] - framesize) into the rotated a1. No overflow check here — the
          // overflow was already handled at the CALL that wrote a[CALLINC*4] (see call()).
          const frame = ((word >> 12) & 0xfff) << 3; // imm12 in 8-byte units
          const newSp = (this.a(s) - frame) | 0;     // read old SP before rotating
          const newBase = (this.windowBase + this.callInc) % WIN_COUNT;
          this.windowBase = newBase;
          this.windowStart |= 1 << newBase;
          this.setA(1, newSp);
          break;
        }
        if (n === 0x3 && ((word >> 6) & 0x3) === 0x1) {
          // LOOP/LOOPNEZ/LOOPGTZ a[s], imm8 — set up a zero-overhead loop. r picks the
          // variant. LBEG = next instr, LEND = pc+4+imm8 (body end). The loop runs a[s]
          // times; NEZ/GTZ skip the body when the count is 0 / non-positive.
          const imm8 = (word >> 16) & 0xff;
          const cnt = this.a(s);
          const skip = (r === 0x9 && cnt === 0) || (r === 0xa && cnt <= 0);
          this.sr[SR_LBEG] = (pc + 3) >>> 0;
          this.sr[SR_LEND] = (pc + 4 + imm8) >>> 0;
          this.sr[SR_LCOUNT] = skip ? 0 : (cnt - 1) | 0;
          if (skip) nextPc = this.sr[SR_LEND] >>> 0;
          break;
        }
        if (n === 0x3 && ((word >> 6) & 0x3) >= 0x2) {
          // BI1: BLTUI (m=2) / BGEUI (m=3) — unsigned compare a[s] vs B4CONSTU[r].
          const c = B4CONSTU[r] >>> 0;
          const target = (pc + 4 + sext((word >> 16) & 0xff, 8)) >>> 0;
          const as = this.a(s) >>> 0;
          if (((word >> 6) & 0x3) === 0x2 ? as < c : as >= c) nextPc = target;
          break;
        }
        if (n === 0x2) {
          // BI0: compare a[s] to a B4CONST constant. m = bits[7:6], r = const index,
          // imm8 = bits[23:16] branch offset.
          const m = (word >> 6) & 0x3;
          const c = B4CONST[r];
          const target = (pc + 4 + sext((word >> 16) & 0xff, 8)) >>> 0;
          const as = this.a(s);
          const take = m === 0x0 ? as === c : m === 0x1 ? as !== c : m === 0x2 ? as < c : as >= c;
          if (take) nextPc = target; // BEQI / BNEI / BLTI / BGEI
          break;
        }
        if (n === 0x1) {
          // BZ: m = bits[7:6], imm12 = bits[23:12], compares a[s] to 0.
          const m = (word >> 6) & 0x3;
          const imm12 = (word >> 12) & 0xfff;
          const target = (pc + 4 + sext(imm12, 12)) >>> 0;
          const as = this.a(s);
          const take = m === 0x0 ? as === 0 : m === 0x1 ? as !== 0 : m === 0x2 ? as < 0 : as >= 0;
          if (take) nextPc = target; // BEQZ / BNEZ / BLTZ / BGEZ
          break;
        }
        throw new UnsupportedInstruction(word, pc);
      }

      case 0x7: {
        // B (RRI8) conditional branch. r selects the condition. imm8 = bits[23:16].
        // r 6/7 and e/f are bit-immediate (BBCI/BBSI) — t joins the bit index, not a[t].
        const target = (pc + 4 + sext((word >> 16) & 0xff, 8)) >>> 0;
        const as = this.a(s);
        const at = this.a(t);
        let take: boolean;
        switch (r) {
          case 0x0: take = (as & at) === 0; break;                       // BNONE
          case 0x1: take = as === at; break;                             // BEQ
          case 0x2: take = as < at; break;                               // BLT
          case 0x3: take = (as >>> 0) < (at >>> 0); break;               // BLTU
          case 0x4: take = (as & at) === at; break;                      // BALL
          case 0x5: take = (as & (1 << (at & 31))) === 0; break;         // BBC
          case 0x8: take = (as & at) !== 0; break;                       // BANY
          case 0x9: take = as !== at; break;                             // BNE
          case 0xa: take = as >= at; break;                              // BGE
          case 0xb: take = (as >>> 0) >= (at >>> 0); break;              // BGEU
          case 0xc: take = (as & at) !== at; break;                      // BNALL
          case 0xd: take = (as & (1 << (at & 31))) !== 0; break;         // BBS
          case 0x6: case 0x7: take = (as & (1 << (((r & 1) << 4) | t))) === 0; break; // BBCI
          case 0xe: case 0xf: take = (as & (1 << (((r & 1) << 4) | t))) !== 0; break; // BBSI
          default: throw new UnsupportedInstruction(word, pc);
        }
        if (take) nextPc = target;
        break;
      }

      case 0x8: // L32I.N  a[t] = mem32[a[s] + r*4]
        this.setA(t, this.bus.read32((this.a(s) + r * 4) >>> 0) | 0);
        break;

      case 0x9: // S32I.N  mem32[a[s] + r*4] = a[t]
        this.bus.write32((this.a(s) + r * 4) >>> 0, this.a(t));
        break;

      case 0xa: // ADD.N  a[r] = a[s] + a[t]
        this.setA(r, (this.a(s) + this.a(t)) | 0);
        break;

      case 0xb: // ADDI.N  a[r] = a[s] + imm  (imm = t, but t==0 encodes -1)
        this.setA(r, (this.a(s) + (t === 0 ? -1 : t)) | 0);
        break;

      case 0xc: {
        // ST2 narrow group: bit7=0 → MOVI.N; bit7=1 → BEQZ.N (bit6=0) / BNEZ.N (bit6=1).
        if ((word >> 7) & 1) {
          // Forward-only 6-bit branch offset: imm6 = (bits[5:4] << 4) | bits[15:12].
          const imm6 = (((word >> 4) & 0x3) << 4) | ((word >> 12) & 0xf);
          const as = this.a(s);
          const take = ((word >> 6) & 1) === 0 ? as === 0 : as !== 0;
          if (take) nextPc = (pc + 4 + imm6) >>> 0; // BEQZ.N / BNEZ.N
          break;
        }
        // MOVI.N a[s], imm7  (imm = (hi3<<4)|lo4, range -32..95)
        const lo4 = r; // bits[15:12]
        const hi3 = (word >> 4) & 0x7; // bits[6:4]
        let imm = (hi3 << 4) | lo4;
        if ((imm & 0x60) === 0x60) imm -= 0x80; // sign for -32..-1
        this.setA(s, imm | 0);
        break;
      }

      case 0xd: {
        // Narrow MOV.N (r==0) / S3 group (r==0xf: RET.N, NOP.N, …).
        if (r === 0x0) {
          this.setA(t, this.a(s)); // MOV.N a[t] = a[s]
          break;
        }
        if (r === 0xf) {
          if (t === 0x3) break; // NOP.N
          if (t === 0x0) {
            nextPc = this.a(0) >>> 0; // RET.N → pc = a0
            break;
          }
          if (t === 0x1) {
            nextPc = this.retw(pc); // RETW.N → windowed return
            break;
          }
        }
        throw new UnsupportedInstruction(word, pc);
      }

      default:
        throw new UnsupportedInstruction(word, pc);
    }

    this._pc = nextPc;
    return 1;
  }
}
