import { MmioDevice } from "../cpu";
export declare const GPIO_BASE = 1072971776;
export declare class GpioDevice implements MmioDevice {
    readonly base = 1072971776;
    readonly size = 256;
    private out;
    private enable;
    private inReg;
    private lastLevel;
    /** Called for each enabled GPIO whose driven level changed (M1 → PinManager). */
    onOutput?: (pin: number, level: 0 | 1) => void;
    read32(offset: number): number;
    write32(offset: number, value: number): void;
    /** Drive an input pin level (button/sensor → CPU). */
    setInput(pin: number, level: boolean): void;
    private emitChanges;
}
//# sourceMappingURL=gpio.d.ts.map