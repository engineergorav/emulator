import { HleHook } from "../cpu";
/** Optional SoC-level callbacks the ROM stubs feed (e.g. starting the second core). */
export interface Esp32RomCtx {
    /** Core 0 called ets_set_appcpu_boot_addr(addr) — the APP CPU (core 1) entry point.
     *  Called with 0 when core 1 clears it; the harness ignores that. */
    onSetAppCpuBootAddr?: (bootAddr: number) => void;
}
export declare function esp32RomHooks(ctx?: Esp32RomCtx): Map<number, HleHook>;
/** Names by address, for the boot probe / debugger to label intercepted calls. */
export declare function esp32RomNames(): Map<number, string>;
//# sourceMappingURL=esp32Rom.d.ts.map