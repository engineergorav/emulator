import { Bus, MmioDevice } from "./cpu";
export declare class SystemBus implements Bus {
    private readonly regions;
    private readonly devices;
    constructor(ramBase: number, ramSize: number);
    /** Add a backing RAM region [base, base+size). Regions must not overlap each other
     *  or a device range. Returns the bus for chaining. */
    addRegion(base: number, size: number): this;
    /** True if [addr, addr+len) lies entirely within one RAM region (loader bounds check). */
    hasRegion(addr: number, len?: number): boolean;
    /** Attach a memory-mapped peripheral. Ranges must not overlap RAM. */
    addDevice(device: MmioDevice): void;
    private regionFor;
    private deviceFor;
    read8(addr: number): number;
    read16(addr: number): number;
    read32(addr: number): number;
    write8(addr: number, value: number): void;
    write16(addr: number, value: number): void;
    write32(addr: number, value: number): void;
}
//# sourceMappingURL=memory.d.ts.map