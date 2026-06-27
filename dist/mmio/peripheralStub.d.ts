import { MmioDevice } from "../cpu";
export declare const PERIPHERAL_BASE = 1072693248;
export declare const PERIPHERAL_SIZE = 524288;
export declare class PeripheralStub implements MmioDevice {
    readonly base: number;
    readonly size: number;
    private readonly seenRead;
    private readonly seenWrite;
    private readonly values;
    /** Fired the first time a given register is read/written, for the boot probe + debugger. */
    onFirstAccess?: (addr: number, isWrite: boolean, value: number) => void;
    constructor(base?: number, size?: number);
    /** Pre-set a register's read value (absolute address) — for the few registers whose
     *  zero default would break boot (the bootloader normally programs them). */
    seed(addr: number, value: number): void;
    read32(offset: number): number;
    write32(offset: number, value: number): void;
    /** Sorted list of distinct registers accessed — the modeling worklist. */
    accessed(): {
        reads: number[];
        writes: number[];
    };
}
//# sourceMappingURL=peripheralStub.d.ts.map