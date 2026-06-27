// @workspace/esp-core — in-house classic-ESP32 (Xtensa LX6) emulator core.
// The browser wrapper (Esp32Simulator) and Node smoke harnesses import from here.
// Cores depend only on the `Bus`; nothing here imports React (R1).

export type { Cpu, Bus, MmioDevice } from "./cpu";
export { UnsupportedInstruction, UnmappedAccess, WindowException } from "./cpu";
export { SystemBus } from "./memory";
export { XtensaLX6Core } from "./xtensa/core";
export { RiscVStubCore } from "./riscv/stub";
export { GpioDevice, GPIO_BASE } from "./mmio/gpio";
export { PeripheralStub, PERIPHERAL_BASE, PERIPHERAL_SIZE } from "./mmio/peripheralStub";
export { TimerGroupDevice, TIMERG0_BASE, TIMERG1_BASE } from "./mmio/timerGroup";
export type { TimerGroupOptions } from "./mmio/timerGroup";
export { RtcCntlDevice, RTC_CNTL_BASE } from "./mmio/rtcCntl";
export type { RtcCntlOptions } from "./mmio/rtcCntl";
export { parseAppImage, loadAppImage, ESP32_RAM_REGIONS, ESP32_STACK_TOP } from "./image/appImage";
export type { AppImage, AppSegment } from "./image/appImage";
export { esp32RomHooks, esp32RomNames } from "./rom/esp32Rom";
export type { Esp32RomCtx } from "./rom/esp32Rom";
export type { HleContext, HleHook } from "./cpu";
