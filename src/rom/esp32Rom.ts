// ESP32 mask-ROM function stand-ins (High-Level Emulation). The Arduino/IDF runtime
// calls helper functions that live in the chip's ROM (fixed addresses from
// esp32.rom.ld). Rather than ship + execute the proprietary ROM blob (and emulate every
// peripheral it pokes), we intercept the call and emulate the function's *effect* in JS
// (ADR-005). This table is the HLE worklist: each entry is a ROM address discovered by
// running real firmware through esp32-boot-probe.mjs, named via the ELF disassembly.
//
// Build the map with esp32RomHooks() and install it on the core.

import { HleContext, HleHook } from "../cpu";

/** Address → stand-in. Addresses are the ESP32 v3 ROM symbol addresses. */
const STUBS: Array<{ addr: number; name: string; hook: HleHook }> = [
  {
    addr: 0x400081d4,
    name: "esp_rom_get_reset_reason",
    // int esp_rom_get_reset_reason(int cpu_no) — report a normal power-on reset so
    // startup takes the cold-boot path (1 = POWERON_RESET on the ESP32).
    hook: (c: HleContext) => c.hookReturn(1),
  },
  // Flash-cache control ROM helpers. We statically pre-map every image segment to its
  // virtual address (ADR-005), so there is no real cache to flush/enable/disable —
  // these are safe no-ops (the function just returns).
  { addr: 0x40009a14, name: "Cache_Flush_rom", hook: () => {} },
  { addr: 0x40009a84, name: "Cache_Read_Enable_rom", hook: () => {} },
  { addr: 0x40009ab8, name: "Cache_Read_Disable_rom", hook: () => {} },
  { addr: 0x400095a4, name: "mmu_init", hook: () => {} }, // segments pre-mapped → no MMU to set up
  { addr: 0x40008534, name: "ets_delay_us", hook: () => {} }, // busy-wait delay — timing is a no-op for now
  // ROM UART/printf console setup — we capture serial via the UART device (M2.3), so no-op.
  { addr: 0x40007d28, name: "esp_rom_install_uart_printf", hook: () => {} },
  { addr: 0x40009028, name: "esp_rom_output_set_as_console", hook: () => {} },
  { addr: 0x4000681c, name: "intr_matrix_set", hook: () => {} }, // interrupt routing — M2.2 territory
  // Internal analog "regi2c" bus — clock bring-up programs the BBPLL / RTC regulators
  // through it (rom_i2c_writeReg(block, host, reg, data) etc.). We frequency-cap the CPU
  // and don't model the analog PLL, so configuring it is a no-op; reads return 0 (the
  // read-modify-write of a field just writes the field into a zeroed register).
  { addr: 0x40004148, name: "rom_i2c_readReg", hook: (c: HleContext) => c.hookReturn(0) },
  { addr: 0x400041a4, name: "rom_i2c_writeReg", hook: () => {} },
  { addr: 0x400041c0, name: "rom_i2c_readReg_Mask", hook: (c: HleContext) => c.hookReturn(0) },
  { addr: 0x400041fc, name: "rom_i2c_writeReg_Mask", hook: () => {} },
  // GPIO matrix / pad routing. Our GpioDevice models the GPIO registers directly, so the
  // peripheral-signal-to-pad routing and pad config are no-ops (TX is captured at the UART
  // FIFO regardless of which pad the matrix would route it to).
  { addr: 0x40009edc, name: "gpio_matrix_in", hook: () => {} },
  { addr: 0x40009fdc, name: "gpio_pad_select_gpio", hook: () => {} },
  { addr: 0x4000a22c, name: "gpio_pad_pullup_only", hook: () => {} },
  // SPI-flash setup. We pre-load the image segments instead of fetching from flash
  // (ADR-005), so configuring the flash clock/pins/params is a no-op → success
  // (ESP_ROM_SPIFLASH_RESULT_OK == 0). Actual read/write helpers are modeled if hit.
  { addr: 0x40061ddc, name: "esp_rom_spiflash_select_qio_pins", hook: () => {} },
  { addr: 0x40062bc8, name: "esp_rom_spiflash_config_clk", hook: (c: HleContext) => c.hookReturn(0) },
  { addr: 0x40063238, name: "esp_rom_spiflash_config_param", hook: (c: HleContext) => c.hookReturn(0) },
  {
    addr: 0x4000bfdc,
    name: "_xtos_set_intlevel",
    // int _xtos_set_intlevel(int level) — raise PS.INTLEVEL, return the old PS. No
    // interrupts modeled until M2.2, so the level change is moot; return 0 (a later
    // restore writing PS=0 is harmless).
    hook: (c: HleContext) => c.hookReturn(0),
  },
  {
    addr: 0x40008658,
    name: "ets_efuse_get_spiconfig",
    // uint32 ets_efuse_get_spiconfig(void) — 0 = default SPI flash pins (standard WROOM).
    hook: (c: HleContext) => c.hookReturn(0),
  },
  {
    addr: 0x40064ae0,
    name: "__bswapsi2",
    // uint32 __bswapsi2(uint32 x) — reverse byte order (libgcc helper in ROM).
    hook: (c: HleContext) => {
      const x = c.hookArg(0) >>> 0;
      c.hookReturn(
        (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) | 0,
      );
    },
  },
  {
    addr: 0x4000c818,
    name: "__ashldi3",
    // int64 __ashldi3(int64 a, int b) — a << b. The 64-bit arg is a2(lo):a3(hi),
    // count in a4; result returns in a2:a3.
    hook: (c: HleContext) => {
      const a = (BigInt(c.hookArg(1) >>> 0) << 32n) | BigInt(c.hookArg(0) >>> 0);
      const r = (a << BigInt(c.hookArg(2) & 63)) & 0xffffffffffffffffn;
      c.hookReturn2(Number(r & 0xffffffffn) | 0, Number((r >> 32n) & 0xffffffffn) | 0);
    },
  },
  {
    addr: 0x4000cff8,
    name: "__udivdi3",
    // uint64 __udivdi3(uint64 a, uint64 b) — a/b. Args a2:a3 (a) and a4:a5 (b); result a2:a3.
    hook: (c: HleContext) => {
      const a = (BigInt(c.hookArg(1) >>> 0) << 32n) | BigInt(c.hookArg(0) >>> 0);
      const b = (BigInt(c.hookArg(3) >>> 0) << 32n) | BigInt(c.hookArg(2) >>> 0);
      const q = b === 0n ? 0n : a / b;
      c.hookReturn2(Number(q & 0xffffffffn) | 0, Number((q >> 32n) & 0xffffffffn) | 0);
    },
  },
];

/** Optional SoC-level callbacks the ROM stubs feed (e.g. starting the second core). */
export interface Esp32RomCtx {
  /** Core 0 called ets_set_appcpu_boot_addr(addr) — the APP CPU (core 1) entry point.
   *  Called with 0 when core 1 clears it; the harness ignores that. */
  onSetAppCpuBootAddr?: (bootAddr: number) => void;
  /** Text the ROM printf (ets_printf) produced — the early-boot log, before the UART
   *  driver takes over. The harness/wrapper routes it to the serial console. */
  onRomPrint?: (text: string) => void;
}

/** Read a NUL-terminated C string from guest memory (bounded). */
function readCString(c: HleContext, addr: number, max = 512): string {
  let s = "";
  for (let i = 0; i < max; i++) {
    const b = c.readMem((addr + i) >>> 0, 1)[0];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** Minimal C printf for the ROM console (ets_printf). Covers the conversions early-boot
 *  logging actually uses — %% %c %s %d/%i %u %x/%X %p, with flags/width/precision and the
 *  l/ll length modifiers. Varargs come from the windowed call registers (a3..a7 → up to
 *  five after the format). Returns the character count, like the real ets_printf. */
function romPrintf(c: HleContext, onPrint?: (s: string) => void): number {
  const fmt = readCString(c, c.hookArg(0) >>> 0);
  let argIdx = 1;
  const nextArg = (): number => (argIdx <= 5 ? c.hookArg(argIdx++) : (argIdx++, 0)) >>> 0;
  const next64 = (): bigint => {
    const lo = BigInt(nextArg());
    const hi = BigInt(nextArg());
    return (hi << 32n) | lo;
  };
  let out = "";
  for (let i = 0; i < fmt.length; i++) {
    if (fmt[i] !== "%") { out += fmt[i]; continue; }
    i++;
    let flags = "";
    while (i < fmt.length && "-+ 0#".includes(fmt[i])) flags += fmt[i++];
    let width = "";
    while (i < fmt.length && fmt[i] >= "0" && fmt[i] <= "9") width += fmt[i++];
    let prec = "";
    if (fmt[i] === ".") { i++; while (i < fmt.length && fmt[i] >= "0" && fmt[i] <= "9") prec += fmt[i++]; }
    let longCount = 0;
    while (i < fmt.length && "lhzjt".includes(fmt[i])) { if (fmt[i] === "l") longCount++; i++; }
    const conv = fmt[i];
    let str: string;
    switch (conv) {
      case "%": str = "%"; break;
      case "c": str = String.fromCharCode(nextArg() & 0xff); break;
      case "s": {
        const p = nextArg();
        str = p ? readCString(c, p) : "(null)";
        if (prec) str = str.slice(0, parseInt(prec, 10));
        break;
      }
      case "d": case "i": {
        if (longCount >= 2) { let v = next64(); if (v & (1n << 63n)) v -= 1n << 64n; str = v.toString(); }
        else str = (nextArg() | 0).toString();
        break;
      }
      case "u": str = longCount >= 2 ? next64().toString() : (nextArg() >>> 0).toString(); break;
      case "x": case "X": {
        const s2 = (longCount >= 2 ? next64() : BigInt(nextArg() >>> 0)).toString(16);
        str = conv === "X" ? s2.toUpperCase() : s2;
        break;
      }
      case "p": str = "0x" + (nextArg() >>> 0).toString(16); break;
      default: str = "%" + (conv ?? ""); break;
    }
    if (width) {
      const w = parseInt(width, 10);
      if (str.length < w) {
        const pad = flags.includes("-") ? null : (flags.includes("0") ? "0" : " ");
        str = pad === null ? str + " ".repeat(w - str.length) : pad.repeat(w - str.length) + str;
      }
    }
    out += str;
  }
  onPrint?.(out);
  return out.length;
}

const ETS_SET_APPCPU_BOOT_ADDR = 0x4000689c;
const ETS_UPDATE_CPU_FREQUENCY = 0x40008550;
const ETS_GET_CPU_FREQUENCY = 0x4000855c;
const ETS_PRINTF = 0x40007d54; // ets_printf / esp_rom_printf — early-boot console

export function esp32RomHooks(ctx: Esp32RomCtx = {}): Map<number, HleHook> {
  const map = new Map<number, HleHook>();
  for (const s of STUBS) map.set(s.addr >>> 0, s.hook);
  // void ets_set_appcpu_boot_addr(uint32 addr) — records where core 1 should boot.
  // We don't store it in ROM data; we surface it so the harness can start core 1 (M2.4).
  map.set(ETS_SET_APPCPU_BOOT_ADDR, (c: HleContext) => ctx.onSetAppCpuBootAddr?.(c.hookArg(0) >>> 0));

  // ets_update_cpu_frequency(mhz) / ets_get_cpu_frequency() are a setter/getter over a
  // ROM data variable (CPU ticks-per-µs == MHz). The clock code updates it as it switches
  // XTAL→PLL; timing helpers read it back. Model the real shared value; default 40 (XTAL
  // at reset) so an early read is never 0 (a 0 would divide-by-zero in delay math).
  let cpuFreqMhz = 40;
  map.set(ETS_UPDATE_CPU_FREQUENCY, (c: HleContext) => { cpuFreqMhz = c.hookArg(0) >>> 0; });
  map.set(ETS_GET_CPU_FREQUENCY, (c: HleContext) => c.hookReturn(cpuFreqMhz));

  // int ets_printf(const char* fmt, ...) — format in JS and emit the early-boot log.
  map.set(ETS_PRINTF, (c: HleContext) => c.hookReturn(romPrintf(c, ctx.onRomPrint)));
  return map;
}

/** Names by address, for the boot probe / debugger to label intercepted calls. */
export function esp32RomNames(): Map<number, string> {
  const map = new Map<number, string>();
  for (const s of STUBS) map.set(s.addr >>> 0, s.name);
  map.set(ETS_SET_APPCPU_BOOT_ADDR, "ets_set_appcpu_boot_addr");
  map.set(ETS_UPDATE_CPU_FREQUENCY, "ets_update_cpu_frequency");
  map.set(ETS_GET_CPU_FREQUENCY, "ets_get_cpu_frequency");
  map.set(ETS_PRINTF, "ets_printf");
  return map;
}
