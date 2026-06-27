import { Bus, Cpu } from "../cpu";
export declare class RiscVStubCore implements Cpu {
    private readonly bus;
    readonly name = "riscv-stub";
    private readonly x;
    private _pc;
    private _cycles;
    constructor(bus: Bus);
    reset(): void;
    get pc(): number;
    set pc(v: number);
    get cycles(): number;
    readReg(index: number): number;
    writeReg(index: number, value: number): void;
    readMem(addr: number, length: number): Uint8Array;
    writeMem(addr: number, data: Uint8Array): void;
    step(): number;
}
//# sourceMappingURL=stub.d.ts.map