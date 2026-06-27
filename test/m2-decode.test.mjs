// M2.1 decode/execute test — the instruction forms that real Arduino-ESP32 startup
// uses beyond the M0 set: special registers (RSR/WSR), EXTUI, the SAR-based dynamic
// shifts (SSL/SLL, SSR/SRL), the BI0 immediate branch (BEQI), bit-test branch (BBSI),
// the zero-overhead LOOP, 16-bit load/store, ADDI.N, and the HLE ROM-hook mechanism.
// All instruction bytes came from the xtensa-esp32-elf decode oracle.
//
// Run: node lib/esp-core/test/m2-decode.test.mjs
import { pathToFileURL } from "url";
import { writeFileSync, rmSync } from "fs";

const { build } = await import(
  pathToFileURL("D:/Routing-Engine/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/main.js").href
);
const res = await build({
  entryPoints: ["D:/Routing-Engine/lib/esp-core/src/index.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
  loader: { ".ts": "ts" },
});
const tmp = "D:/Routing-Engine/lib/esp-core/test/_m2_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { XtensaLX6Core, SystemBus } = mod;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = got | 0, w = want | 0;
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}: got 0x${(g >>> 0).toString(16)}, want 0x${(w >>> 0).toString(16)}`); }
};

function makeCore(bytes, loadAt = 0) {
  const bus = new SystemBus(0, 0x10000);
  for (let i = 0; i < bytes.length; i++) bus.write8(loadAt + i, bytes[i]);
  const core = new XtensaLX6Core(bus);
  core.reset();
  core.pc = loadAt;
  return { bus, core };
}

// ── RSR/WSR round-trip via SAR ───────────────────────────────────────────────
// wsr.sar a4 ; rsr.sar a3   → a3 == a4
{
  const { core } = makeCore([0x40,0x03,0x13, 0x30,0x03,0x03]);
  core.writeReg(4, 7);
  core.step(); core.step();
  eq("RSR/WSR sar round-trip", core.readReg(3), 7);
}

// ── EXTUI a3, a4, 0, 8  → a3 = a4 & 0xff ─────────────────────────────────────
{
  const { core } = makeCore([0x40,0x30,0x74]);
  core.writeReg(4, 0x12345678 | 0);
  core.step();
  eq("EXTUI low byte", core.readReg(3), 0x78);
}

// ── SSR a6 ; SRL a7, a8  → a7 = a8 >>> 4 ─────────────────────────────────────
{
  const { core } = makeCore([0x00,0x06,0x40, 0x80,0x70,0x91]);
  core.writeReg(6, 4);
  core.writeReg(8, 0xf0);
  core.step(); core.step();
  eq("SSR/SRL right shift", core.readReg(7), 0x0f);
}

// ── SSL a4 ; SLL a3, a5  → a3 = a5 << 4 ──────────────────────────────────────
{
  const { core } = makeCore([0x00,0x14,0x40, 0x00,0x35,0xa1]);
  core.writeReg(4, 4);
  core.writeReg(5, 0x0f);
  core.step(); core.step();
  eq("SSL/SLL left shift", core.readReg(3), 0xf0);
}

// ── BEQI a2, 5, +20 (taken vs not) ───────────────────────────────────────────
{
  let { core } = makeCore([0x26,0x52,0x14]); // target = pc+4+20 = 0x18
  core.writeReg(2, 5); core.step();
  eq("BEQI taken pc", core.pc, 0x18);
  ({ core } = makeCore([0x26,0x52,0x14]));
  core.writeReg(2, 4); core.step();
  eq("BEQI not-taken pc", core.pc, 3);
}

// ── BBSI a4, bit5, +17 (taken when bit set) ──────────────────────────────────
{
  let { core } = makeCore([0x57,0xe4,0x11]); // target = pc+4+17 = 0x15
  core.writeReg(4, 1 << 5); core.step();
  eq("BBSI taken pc", core.pc, 0x15);
  ({ core } = makeCore([0x57,0xe4,0x11]));
  core.writeReg(4, 0); core.step();
  eq("BBSI not-taken pc", core.pc, 3);
}

// ── LOOP a3, body  → body runs a3 times ──────────────────────────────────────
// loop a3,+1 ; addi.n a4,a4,1 ; nop.n      (a3=3, a4=0 → a4 ends at 3)
{
  const { core } = makeCore([0x76,0x83,0x01, 0x1b,0x44, 0x3d,0xf0]);
  core.writeReg(3, 3);
  core.writeReg(4, 0);
  for (let i = 0; i < 5; i++) core.step();
  eq("LOOP body ran 3x", core.readReg(4), 3);
  eq("LOOP pc past body", core.pc, 7);
}

// ── 16-bit store/load (S16I / L16UI) ─────────────────────────────────────────
// s16i a8,a6,8 ; l16ui a5,a6,4   with mem preset
{
  const { bus, core } = makeCore([0x82,0x56,0x04, 0x52,0x16,0x02]);
  core.writeReg(6, 0x400);
  core.writeReg(8, 0xbeef);
  core.step(); // store a8 → mem16[0x408]
  eq("S16I stored", bus.read16(0x408), 0xbeef);
  bus.write16(0x404, 0x1234);
  core.step(); // load mem16[0x404] → a5
  eq("L16UI loaded", core.readReg(5), 0x1234);
}

// ── ADDI.N a9, a10, 2 ────────────────────────────────────────────────────────
{
  const { core } = makeCore([0x2b,0x9a]);
  core.writeReg(10, 40);
  core.step();
  eq("ADDI.N", core.readReg(9), 42);
}

// ── HLE ROM hook: callx8 into ROM addr → hook supplies the return value ───────
// Caller runs in IRAM (0x40100000) and calls a stubbed ROM function at 0x40005000.
{
  const bus = new SystemBus(0x40100000, 0x1000);
  bus.write8(0x40100000, 0xe0); bus.write8(0x40100001, 0x08); bus.write8(0x40100002, 0x00); // callx8 a8
  const core = new XtensaLX6Core(bus);
  core.installHooks(new Map([[0x40005000, (c) => c.hookReturn(0xabc + c.hookArg(0))]]));
  core.reset();
  core.pc = 0x40100000;
  core.writeReg(8, 0x40005000); // call target (ROM)
  core.writeReg(10, 4);         // arg0 → callee a2 (call8: caller a10 → a2)
  core.step(); // callx8 → enters ROM addr
  core.step(); // HLE hook runs, returns 0xabc+4
  eq("HLE return value in caller a10", core.readReg(10) >>> 0, 0xac0);
  eq("HLE returned to caller", core.pc, 0x40100003);
}

// ── BEQZ.N / BNEZ.N (narrow zero-branch — shares op0=0xc with MOVI.N via bit7) ────
// Regression for the decode bug where beqz.n was executed as movi.n and corrupted a reg.
{
  let { core } = makeCore([0x8c, 0x47]); // beqz.n a7, +4 → target 0x8
  core.writeReg(7, 0); core.step();
  eq("BEQZ.N taken pc", core.pc, 0x8);
  ({ core } = makeCore([0x8c, 0x47]));
  core.writeReg(7, 5); core.step();
  eq("BEQZ.N not-taken pc", core.pc, 2);
  ({ core } = makeCore([0xcc, 0x24])); // bnez.n a4, +2 → target 0x6
  core.writeReg(4, 5); core.step();
  eq("BNEZ.N taken pc", core.pc, 0x6);
  ({ core } = makeCore([0xcc, 0x24]));
  core.writeReg(4, 0); core.step();
  eq("BNEZ.N not-taken pc", core.pc, 2);
}
// MOVI.N must still decode (bit7=0) — guards the split:
{
  const { core } = makeCore([0x6c, 0x03]); // movi.n a3, -32
  core.step();
  eq("MOVI.N still works", core.readReg(3), -32);
}

// ── ADDMI a3, a4, 0x100 ──────────────────────────────────────────────────────
{
  const { core } = makeCore([0x32, 0xd4, 0x01]);
  core.writeReg(4, 0x500);
  core.step();
  eq("ADDMI", core.readReg(3) >>> 0, 0x600);
}

// ── Conditional moves (MOVEQZ / MOVNEZ) ──────────────────────────────────────
{
  let { core } = makeCore([0x50, 0x34, 0x83]); // moveqz a3, a4, a5
  core.writeReg(3, 0x11); core.writeReg(4, 0x22); core.writeReg(5, 0);
  core.step();
  eq("MOVEQZ moves when a5==0", core.readReg(3), 0x22);
  ({ core } = makeCore([0x50, 0x34, 0x83]));
  core.writeReg(3, 0x11); core.writeReg(4, 0x22); core.writeReg(5, 9);
  core.step();
  eq("MOVEQZ keeps when a5!=0", core.readReg(3), 0x11);
}

// ── MIN / MAXU ───────────────────────────────────────────────────────────────
{
  let { core } = makeCore([0x50, 0x34, 0x43]); // min a3, a4, a5 (signed)
  core.writeReg(4, -5); core.writeReg(5, 3); core.step();
  eq("MIN signed", core.readReg(3), -5);
  ({ core } = makeCore([0x50, 0x34, 0x73])); // maxu a3, a4, a5 (unsigned)
  core.writeReg(4, -1); core.writeReg(5, 3); core.step();
  eq("MAXU unsigned (0xffffffff > 3)", core.readReg(3) >>> 0, 0xffffffff);
}

// ── NEG / ABS / NSAU ─────────────────────────────────────────────────────────
{
  let { core } = makeCore([0x40, 0x30, 0x60]); // neg a3, a4
  core.writeReg(4, 7); core.step();
  eq("NEG", core.readReg(3), -7);
  ({ core } = makeCore([0x40, 0x31, 0x60])); // abs a3, a4
  core.writeReg(4, -123); core.step();
  eq("ABS", core.readReg(3), 123);
  ({ core } = makeCore([0x30, 0xf4, 0x40])); // nsau a3, a4
  core.writeReg(4, 0x00ff0000); core.step();
  eq("NSAU (leading zeros)", core.readReg(3), 8);
}

// ── SEXT a3, a4, 7  (sign-extend from bit 7) ─────────────────────────────────
{
  const { core } = makeCore([0x00, 0x34, 0x23]);
  core.writeReg(4, 0x80); // bit 7 set → negative
  core.step();
  eq("SEXT bit7", core.readReg(3), -128);
}

// ── SSAI 4 ; SRC a3, a4, a5  (funnel shift) ──────────────────────────────────
{
  const { core } = makeCore([0x00, 0x44, 0x40, 0x50, 0x34, 0x81]);
  core.writeReg(4, 0x12345678 | 0); // high
  core.writeReg(5, 0x9abcdef0 | 0); // low
  core.step(); core.step();
  eq("SRC funnel >>4", core.readReg(3) >>> 0, 0x89abcdef);
}

// ── ADDX2/4/8 with DISTINCT operands (regression: scale applies to as, not at) ─
// addx2/4/8 a3, a4, a5  →  a3 = (a4 << n) + a5.  (M0 only tested as==at, masking the bug.)
{
  const cases = [[0x90, 2], [0xa0, 4], [0xb0, 8]]; // op1 byte (hi nibble) → scale
  for (const [b2, scale] of cases) {
    const { core } = makeCore([0x50, 0x34, b2]); // r=3(a3) s=4(a4) t=5(a5)
    core.writeReg(4, 10); core.writeReg(5, 3);
    core.step();
    eq(`ADDX${scale} = ${scale}*as+at`, core.readReg(3), scale * 10 + 3);
  }
}

// ── S32C1I atomic compare-and-swap (SCOMPARE1 defaults to 0 after reset) ──────
{
  // match: mem==SCOMPARE1(0) → store a4, return old(0)
  let { bus, core } = makeCore([0x42, 0xe2, 0x00]); // s32c1i a4, a2, 0
  core.writeReg(2, 0x100); core.writeReg(4, 0xabcd);
  core.step();
  eq("S32C1I match stores", bus.read32(0x100) >>> 0, 0xabcd);
  eq("S32C1I returns old", core.readReg(4), 0);
  // no match: mem(0x99) != SCOMPARE1(0) → no store, return old(0x99)
  ({ bus, core } = makeCore([0x42, 0xe2, 0x00]));
  bus.write32(0x200, 0x99);
  core.writeReg(2, 0x200); core.writeReg(4, 0xabcd);
  core.step();
  eq("S32C1I no-match keeps mem", bus.read32(0x200), 0x99);
  eq("S32C1I no-match returns old", core.readReg(4), 0x99);
}

// ── BLTUI / BGEUI (unsigned — 0xffffffff is large, not -1) ────────────────────
{
  let { core } = makeCore([0xb6, 0x86, 0x05]); // bltui a6, 8, +5 → target 9
  core.writeReg(6, 5); core.step();
  eq("BLTUI taken (5<8)", core.pc, 9);
  ({ core } = makeCore([0xb6, 0x86, 0x05]));
  core.writeReg(6, 0xffffffff | 0); core.step();
  eq("BLTUI not-taken (0xffffffff not < 8 unsigned)", core.pc, 3);
  ({ core } = makeCore([0xf6, 0x86, 0x02])); // bgeui a6, 8, +2 → target 6
  core.writeReg(6, 0xffffffff | 0); core.step();
  eq("BGEUI taken (0xffffffff >= 8 unsigned)", core.pc, 6);
}

// ── Multiply / divide group (RST2: op0=0, op2=2) ─────────────────────────────
// all "a3, a4, a5" → r=3 s=4 t=5; op1 byte selects the op.
{
  const run = (b2, a4v, a5v) => {
    const { core } = makeCore([0x50, 0x34, b2]);
    core.writeReg(4, a4v | 0); core.writeReg(5, a5v | 0);
    core.step();
    return core.readReg(3);
  };
  eq("MULL (low 32)", run(0x82, 7, 6), 42);
  eq("MULUH (high 32 unsigned)", run(0xa2, 0x10000, 0x10000), 1);
  eq("MULSH (high 32 signed)", run(0xb2, -1, 2), -1);
  eq("QUOU (unsigned /)", run(0xc2, 100, 7), 14);
  eq("QUOS (signed /, trunc)", run(0xd2, -100, 7), -14);
  eq("REMU (unsigned %)", run(0xe2, 100, 7), 2);
  eq("REMS (signed %)", run(0xf2, -100, 7), -2);
  eq("QUOU div-by-0 → 0 (no NaN)", run(0xc2, 5, 0), 0);
}

// ── Two cores read distinct PRID (drives the PRO/APP CPU split) ───────────────
{
  const bus = new SystemBus(0, 0x1000);
  // rsr.prid a3  (0x03eb30)
  [0x30, 0xeb, 0x03].forEach((b, i) => bus.write8(i, b));
  const c0 = new XtensaLX6Core(bus, 0); c0.reset(); c0.pc = 0; c0.step();
  const c1 = new XtensaLX6Core(bus, 1); c1.reset(); c1.pc = 0; c1.step();
  eq("PRID core 0 = PRO_CPU", c0.readReg(3) >>> 0, 0xcdcd);
  eq("PRID core 1 = APP_CPU", c1.readReg(3) >>> 0, 0xabab);
  eq("PRID bit13 differs (boot branch)", ((c0.readReg(3) >>> 13) & 1) ^ ((c1.readReg(3) >>> 13) & 1), 1);
}

console.log("");
console.log(fail === 0
  ? `M2 DECODE TEST PASS ✓  (${pass} assertions)`
  : `M2 DECODE TEST FAIL ✗  (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
