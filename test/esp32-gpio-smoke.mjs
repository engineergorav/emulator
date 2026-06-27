// M1 smoke test — the first end-to-end proof: REAL Xtensa machine code, assembled
// by the xtensa-esp32-elf toolchain, executed on XtensaLX6Core, writing the ESP32
// GPIO MMIO registers through SystemBus, drives a pin high — exactly the path that
// will light a wokwi-led in the browser (the GpioDevice.onOutput callback is what
// the wrapper routes to PinManager).
//
// Prereq: arduino-cli ESP32 core installed (provides the toolchain).
// Run: node lib/esp-core/test/esp32-gpio-smoke.mjs
import { pathToFileURL } from "url";
import { writeFileSync, rmSync, readFileSync, mkdirSync } from "fs";
import { execFileSync } from "child_process";

const BIN = "C:/Users/gorav/AppData/Local/Arduino15/packages/esp32/tools/esp-x32/2601/bin";
const GCC = `${BIN}/xtensa-esp32-elf-gcc-14.2.0.exe`;
const OBJCOPY = `${BIN}/xtensa-esp32-elf-objcopy.exe`;
const NM = `${BIN}/xtensa-esp32-elf-nm.exe`;
const LOAD = 0x400000;

const dir = "D:/Routing-Engine/lib/esp-core/test/_m1";
mkdirSync(dir, { recursive: true });

// Bare-metal: enable GPIO2 as output, drive it high, then spin.
const ASM = `
.text
.global _start
_start:
  movi  a2, 0x3FF44024      /* GPIO_ENABLE_W1TS */
  movi  a3, 4               /* 1<<2  (GPIO2)     */
  s32i  a3, a2, 0
  movi  a4, 0x3FF44008      /* GPIO_OUT_W1TS     */
  s32i  a3, a4, 0
1:
  j 1b
`;
writeFileSync(`${dir}/gpio.S`, ASM);

let entry, image;
try {
  execFileSync(GCC, ["-nostdlib", "-mtext-section-literals", `-Wl,-Ttext,0x${LOAD.toString(16)}`,
    "-Wl,-e,_start", `${dir}/gpio.S`, "-o", `${dir}/gpio.elf`], { stdio: "pipe" });
  execFileSync(OBJCOPY, ["-O", "binary", `${dir}/gpio.elf`, `${dir}/gpio.bin`], { stdio: "pipe" });
  const nm = execFileSync(NM, [`${dir}/gpio.elf`], { encoding: "utf8" });
  entry = parseInt(nm.split(/\r?\n/).find((l) => / _start$/.test(l)).slice(0, 8), 16);
  image = new Uint8Array(readFileSync(`${dir}/gpio.bin`));
} catch (e) {
  console.error("TOOLCHAIN STEP FAILED:", e.message);
  process.exit(1);
}
console.log(`  assembled ${image.length} bytes, entry=0x${entry.toString(16)}`);

// Bundle the TS core and import.
const { build } = await import(
  pathToFileURL("D:/Routing-Engine/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/main.js").href
);
const res = await build({
  entryPoints: ["D:/Routing-Engine/lib/esp-core/src/index.ts"],
  bundle: true, format: "esm", platform: "node", write: false, loader: { ".ts": "ts" },
});
const tmp = `${dir}/_core.mjs`;
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { XtensaLX6Core, SystemBus, GpioDevice } = mod;

// Wire it up: RAM holds the program image; GPIO device on the bus.
const bus = new SystemBus(LOAD, 0x10000);
for (let i = 0; i < image.length; i++) bus.write8(LOAD + i, image[i]);
const gpio = new GpioDevice();
bus.addDevice(gpio);

const edges = [];
gpio.onOutput = (pin, level) => edges.push({ pin, level });

const core = new XtensaLX6Core(bus);
core.reset();
core.pc = entry;
for (let i = 0; i < 200; i++) core.step(); // 6 real instrs then spins in j-loop

// Assertions.
let ok = true;
const check = (name, cond) => { if (!cond) { ok = false; console.log(`  ✗ ${name}`); } };
const gpio2High = edges.some((e) => e.pin === 2 && e.level === 1);
check("GpioDevice fired onOutput(pin=2, level=1)", gpio2High);
check("GPIO_OUT bit2 set",    (bus.read32(0x3ff44004) >>> 2) & 1);
check("GPIO_ENABLE bit2 set", (bus.read32(0x3ff44020) >>> 2) & 1);
check("no spurious pin edges", edges.every((e) => e.pin === 2));

console.log(`  pin edges: ${JSON.stringify(edges)}`);
rmSync(dir, { recursive: true, force: true });
console.log(ok ? "\nESP32 GPIO SMOKE PASS ✓  (real Xtensa code drove GPIO2 high via MMIO)"
               : "\nESP32 GPIO SMOKE FAIL ✗");
process.exit(ok ? 0 : 1);
