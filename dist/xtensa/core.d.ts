import { Bus, Cpu, HleContext, HleHook } from "../cpu";
export declare class XtensaLX6Core implements Cpu, HleContext {
    private readonly bus;
    private readonly coreId;
    readonly name = "xtensa-lx6";
    private readonly ar;
    private windowBase;
    private windowStart;
    private callInc;
    private sar;
    private readonly sr;
    private hooks;
    private _pc;
    private _cycles;
    constructor(bus: Bus, coreId?: number);
    reset(): void;
    /** Special-register read (RSR/XSR). SAR + PRID modeled; the rest is plain storage. */
    private readSr;
    /** Special-register write (WSR/XSR). */
    private writeSr;
    /** Window machine state — for the debugger (T4) and the M0 window-rotation tests. */
    windowState(): {
        windowBase: number;
        windowStart: number;
        callInc: number;
    };
    /** Register HLE stand-ins for ROM functions, keyed by their ROM address (ADR-005).
     *  When PC reaches one, the core runs the hook instead of fetching from unmapped ROM. */
    installHooks(hooks: Map<number, HleHook>): void;
    hookArg(i: number): number;
    hookReturn(value: number): void;
    hookReturn2(lo: number, hi: number): void;
    /** Run an HLE ROM hook at `pc`: frame it like the callee's ENTRY+RETW would (rotate
     *  the window by the latched CALLINC so a2.. are the args, run the hook, then return
     *  to the address the windowed CALL stashed in a0). Works for call0/4/8/12 uniformly. */
    private runHook;
    get pc(): number;
    set pc(v: number);
    get cycles(): number;
    readReg(index: number): number;
    writeReg(index: number, value: number): void;
    readMem(addr: number, length: number): Uint8Array;
    writeMem(addr: number, data: Uint8Array): void;
    /** Windowed a-register read (a0..a15). */
    private a;
    /** Windowed a-register write. */
    private setA;
    /** Shared body of CALL0/4/8/12 and CALLX0/4/8/12. Stashes the return address into
     *  the register that becomes the callee's a0 after ENTRY rotates (with the call
     *  increment `n` in its top 2 bits, so RETW knows how far to rotate back), latches
     *  PS.CALLINC, and returns the branch target. The window does NOT rotate here — the
     *  callee's ENTRY consumes CALLINC and rotates. Returns the next PC. */
    private call;
    /** Shared body of RETW (wide) and RETW.N. The current frame's a0 holds the call
     *  increment (top 2 bits) + the return PC (low 30, top 2 inherited from current PC).
     *  Rotate WindowBase back by that increment, clearing the leaving frame's live bit
     *  and checking the caller's is still set (else the caller was spilled → underflow,
     *  which needs the M2 fill vectors; for now a named halt, R2). Returns the next PC. */
    private retw;
    step(): number;
}
//# sourceMappingURL=core.d.ts.map