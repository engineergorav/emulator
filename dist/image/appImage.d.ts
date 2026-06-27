import { SystemBus } from "../memory";
/** ESP32 internal-SRAM + RTC regions, pre-declared so .bss/heap/stack (which are NOT
 *  in the image — startup zero-fills them) have backing memory. The flash-mapped
 *  DROM/IROM segments get regions sized to the segment at load time (ensureRegion). */
export declare const ESP32_RAM_REGIONS: ReadonlyArray<{
    name: string;
    base: number;
    size: number;
}>;
/** Initial stack pointer: top of DRAM, 16-byte aligned. Startup sets its own SP early,
 *  but a sane a1 avoids a fault if anything pushes before that. */
export declare const ESP32_STACK_TOP = 1073741808;
export interface AppSegment {
    loadAddr: number;
    data: Uint8Array;
}
export interface AppImage {
    entry: number;
    segments: AppSegment[];
    segmentCount: number;
}
/** Parse an ESP-IDF app image into its entry point + segments. Does not touch memory. */
export declare function parseAppImage(bytes: Uint8Array): AppImage;
/** Build a SystemBus with the ESP32 memory map, load every segment to its virtual
 *  address, and report the entry point + initial stack pointer. Devices (GPIO/UART/…)
 *  are added by the caller afterward. */
export declare function loadAppImage(bytes: Uint8Array): {
    bus: SystemBus;
    entry: number;
    sp: number;
};
//# sourceMappingURL=appImage.d.ts.map