// M2 boot probe (dev tool, not a checked-in green test — depends on a local .bin).
// Loads a REAL compiled ESP32 app image, jumps to its entry, and reports how far the
// core gets before it stops. The stop reason (UnsupportedInstruction @pc / UnmappedAccess
// @addr / WindowException) is the worklist for M2.1 (decoder broadening) and M2.2/2.3
// (exceptions, peripherals). Re-run after each addition to watch the reach grow.
//
// Usage: node lib/esp-core/test/esp32-boot-probe.mjs [path-to-sketch.ino.bin]
//        (default: ~/m2-probe/out/sketch.ino.bin)
import { pathToFileURL } from "url";
import { writeFileSync, rmSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const binPath = process.argv[2] || join(homedir(), "m2-probe", "out", "sketch.ino.bin");
const MAX_STEPS = Number(process.env.MAX_STEPS || 2_000_000);

const { build } = await import(
  pathToFileURL("D:/Routing-Engine/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/main.js").href
);
const res = await build({
  entryPoints: ["D:/Routing-Engine/lib/esp-core/src/index.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
  loader: { ".ts": "ts" },
});
const tmp = "D:/Routing-Engine/lib/esp-core/test/_probe_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { XtensaLX6Core, loadAppImage, parseAppImage, esp32RomHooks, esp32RomNames, PeripheralStub, TimerGroupDevice, TIMERG0_BASE, RtcCntlDevice } = mod;

let bin;
try {
  bin = new Uint8Array(readFileSync(binPath));
} catch {
  console.log(`\n[probe] no app image at ${binPath}`);
  console.log(`[probe] compile one:  arduino-cli compile --fqbn esp32:esp32:esp32:FlashMode=dio --output-dir <out> <sketch>`);
  process.exit(0);
}

const img = parseAppImage(bin);
console.log(`\n[probe] ${binPath}`);
console.log(`[probe] entry=0x${img.entry.toString(16)}  ${img.segmentCount} segments:`);
for (const s of img.segments) {
  console.log(`          load 0x${s.loadAddr.toString(16).padStart(8, "0")}  len 0x${s.data.length.toString(16)}`);
}

const { bus, entry, sp } = loadAppImage(bin);

// Two cores share the one bus — that is how they hand-shake (via shared memory sync
// flags). Core 1 (APP CPU) stays stalled until core 0 calls ets_set_appcpu_boot_addr;
// then we start it at that entry with its own stack (M2.4 fake-SMP — a real 2nd core).
const CORE1_SP = 0x3fff8000;
let appCpuBootAddr = -1;
let romLog = "";
const hooks = esp32RomHooks({
  onSetAppCpuBootAddr: (addr) => { if (addr) appCpuBootAddr = addr >>> 0; },
  onRomPrint: (text) => { romLog += text; process.stdout.write(text); },
});

const core0 = new XtensaLX6Core(bus, 0);
core0.installHooks(hooks);
core0.reset();
core0.pc = entry;
core0.writeReg(1, sp);

// Set up the outermost frame's base save area, the way the 2nd-stage bootloader does
// before jumping to the app. When the window fills 8 deep, the OLDEST (root) frame is
// spilled; the overflow handler reads [root_sp-12] as the root's caller stack pointer and
// writes the root's a4-a7 into that caller frame's reserved area ([caller_sp-32..]). The
// caller SP must be ABOVE root_sp (the bootloader frame) — which is exactly the initial
// SP, since the root's `entry a1,imm` set root_sp = sp - (imm<<3). Pointing it below would
// make the a4-a7 save collide with the a0-a3 save (a real bug we hit). (entry frame=imm12<<3.)
{
  const w = bus.read8(entry) | (bus.read8(entry + 1) << 8) | (bus.read8(entry + 2) << 16);
  const isEntry = (w & 0xf) === 0x6 && ((w >> 4) & 0x3) === 0x3 && ((w >> 6) & 0x3) === 0x0;
  const rootSp = (sp - (isEntry ? ((w >> 12) & 0xfff) << 3 : 0)) >>> 0;
  bus.write32((rootSp - 12) >>> 0, sp >>> 0); // root caller SP = initial stack top
}

const core1 = new XtensaLX6Core(bus, 1);
core1.installHooks(hooks);
let core1Running = false;

// Real peripherals first (they take precedence over the catch-all stub below, which
// spans the whole window):
//  • TIMERG0 — the RTC slow-clock calibration counter rtc_clk_cal_internal polls.
//  • RTC_CNTL — the 48-bit RTC timer rtc_time_get latches; advances off core 0's cycle
//    count (real time base), and supplies the XTAL frequency (replaces the old seeds).
bus.addDevice(new TimerGroupDevice({ base: TIMERG0_BASE, xtalFreqHz: 40_000_000 }));
bus.addDevice(new RtcCntlDevice({ now: () => core0.cycles, xtalFreqMhz: 40 }));

const periph = new PeripheralStub(); // logged no-op peripheral window (boot-poke policy)
bus.addDevice(periph);

const watchPc = process.env.WATCH_PC ? Number(process.env.WATCH_PC) >>> 0 : -1;
let watchHits = 0;
const describe = (core, label, err) => {
  console.log(`[probe] STOPPED on ${label}: ${err.name}: ${err.message}`);
  const pc = core.pc >>> 0;
  const raw = [];
  try { for (let i = 0; i < 3; i++) raw.push(bus.read8((pc + i) >>> 0)); } catch { /* unmapped */ }
  if (raw.length) console.log(`[probe] bytes @pc=0x${pc.toString(16)}: ${raw.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`);
  const ws = core.windowState();
  const a = (i) => core.readReg((ws.windowBase * 4 + i) & 63) >>> 0;
  const regs = [];
  for (let i = 0; i < 16; i++) regs.push(`a${i}=0x${a(i).toString(16)}`);
  console.log(`[probe] windowBase=${ws.windowBase} ${regs.join(" ")}`);
  // Any a-register pointing at printable bytes is likely a string (panic/printf arg).
  const readStr = (addr) => {
    let s = "";
    try {
      for (let i = 0; i < 80; i++) {
        const b = bus.read8((addr + i) >>> 0);
        if (b === 0) break;
        if (b < 0x20 || b > 0x7e) return null;
        s += String.fromCharCode(b);
      }
    } catch { return null; }
    return s.length >= 3 ? s : null;
  };
  for (let i = 2; i < 14; i++) {
    const str = readStr(a(i));
    if (str) console.log(`[probe]   a${i} → "${str}"`);
  }
};

let steps = 0;
let stop = null; // { core, label, err }
const t0 = Date.now();
for (; steps < MAX_STEPS; steps++) {
  if (!core1Running && appCpuBootAddr >= 0) {
    core1.reset();
    core1.pc = appCpuBootAddr;
    core1.writeReg(1, CORE1_SP);
    core1Running = true;
    console.log(`\n[probe] >>> core 1 (APP CPU) started at 0x${appCpuBootAddr.toString(16)} at core-0 step ${steps.toLocaleString()}`);
  }
  if (watchPc >= 0 && (core0.pc >>> 0) === watchPc && watchHits < 16) {
    const ws = core0.windowState();
    const a = (i) => core0.readReg((ws.windowBase * 4 + i) & 63) >>> 0;
    console.log(`  [watch #${watchHits}] wb=${ws.windowBase} a1=0x${a(1).toString(16)} a4=0x${a(4).toString(16)} a6=0x${a(6).toString(16)}`);
    watchHits++;
  }
  try { core0.step(); } catch (e) { stop = { core: core0, label: "core 0", err: e }; break; }
  if (core1Running) {
    try { core1.step(); } catch (e) { stop = { core: core1, label: "core 1", err: e }; break; }
  }
}
const ms = Date.now() - t0;

console.log(`\n[probe] ${steps.toLocaleString()} core-0 steps in ${ms}ms (~${ms > 0 ? Math.round(steps / ms / 1000) : 0} MIPS); core 1 ${core1Running ? "running" : "not started"}`);
if (stop) {
  describe(stop.core, stop.label, stop.err);
} else {
  console.log(`[probe] reached the step cap with no fault.`);
  // Sample both cores' PCs over 2000 more steps to spot a spin loop.
  for (const [core, label, active] of [[core0, "core 0", true], [core1, "core 1", core1Running]]) {
    if (!active) continue;
    const seen = new Map();
    for (let i = 0; i < 2000; i++) {
      const p = core.pc >>> 0;
      seen.set(p, (seen.get(p) || 0) + 1);
      try { core.step(); } catch { break; }
    }
    const spin = seen.size < 60;
    console.log(`[probe] ${label}: ${seen.size} distinct PCs over 2000 steps${spin ? " → SPIN LOOP" : " → progressing"}`);
    if (spin) {
      const top = [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
      console.log(`[probe]   hottest: ${top.map(([p, n]) => `0x${p.toString(16)}(${n})`).join(" ")}`);
    }
  }
}

const acc = periph.accessed();
if (acc.reads.length || acc.writes.length) {
  const hex = (a) => "0x" + a.toString(16);
  console.log(`\n[probe] peripheral registers touched (modeling worklist):`);
  console.log(`          reads:  ${acc.reads.map(hex).join(", ") || "(none)"}`);
  console.log(`          writes: ${acc.writes.map(hex).join(", ") || "(none)"}`);
}
