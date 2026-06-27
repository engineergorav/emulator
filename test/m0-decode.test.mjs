// M0 decode/execute test — drives the XtensaLX6Core with byte sequences emitted by
// the xtensa-esp32-elf toolchain (the decode oracle; see the section dump in
// docs/notes/xtensa-decode.md) and asserts register/memory/PC results.
//
// Run: node lib/esp-core/test/m0-decode.test.mjs
import { pathToFileURL } from "url";
import { writeFileSync, rmSync } from "fs";

const { build } = await import(
  pathToFileURL("D:/Routing-Engine/node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/lib/main.js").href
);

// Bundle the TS core to ESM so Node can import it.
const res = await build({
  entryPoints: ["D:/Routing-Engine/lib/esp-core/src/index.ts"],
  bundle: true, format: "esm", platform: "node", write: false,
  loader: { ".ts": "ts" },
});
const tmp = "D:/Routing-Engine/lib/esp-core/test/_core_bundle.mjs";
writeFileSync(tmp, res.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(tmp).href); } finally { rmSync(tmp, { force: true }); }
const { XtensaLX6Core, SystemBus } = mod;

let pass = 0, fail = 0;
const eq = (name, got, want) => {
  const g = got | 0, w = want | 0;
  if (g === w) { pass++; }
  else { fail++; console.log(`  ✗ ${name}: got ${g} (0x${(g >>> 0).toString(16)}), want ${w}`); }
};

function makeCore(bytes, loadAt = 0) {
  const bus = new SystemBus(0, 0x10000);
  for (let i = 0; i < bytes.length; i++) bus.write8(loadAt + i, bytes[i]);
  const core = new XtensaLX6Core(bus);
  core.reset();
  core.pc = loadAt;
  return { bus, core };
}

// ── Test 1: arithmetic (movi, movi.n, add.n, addi, sub) ──────────────────────
// movi a2,100 | movi.n a3,5 | add.n a4,a2,a3 | add.n a5,a2,a3 | addi a6,a2,-7 | sub a7,a2,a3
{
  const prog = [0x22,0xa0,0x64, 0x0c,0x53, 0x3a,0x42, 0x3a,0x52, 0x62,0xc2,0xf9, 0x30,0x72,0xc0];
  const { core } = makeCore(prog);
  for (let i = 0; i < 6; i++) core.step();
  eq("a2 (movi 100)",   core.readReg(2), 100);
  eq("a3 (movi.n 5)",   core.readReg(3), 5);
  eq("a4 (add.n)",      core.readReg(4), 105);
  eq("a5 (add.n)",      core.readReg(5), 105);
  eq("a6 (addi -7)",    core.readReg(6), 93);
  eq("a7 (sub)",        core.readReg(7), 95);
}

// ── Test 2: memory (s32i.n / l32i.n) ─────────────────────────────────────────
// preset a2=base(0x200), a8=0xABCD; s32i.n a8,a2,20 → mem32[0x214]; then
// preset mem32[0x210]=0x1234; l32i.n a8,a2,16 → a8.
{
  const store = [0x89,0x52]; // s32i.n a8,a2,20
  const load  = [0x88,0x42]; // l32i.n a8,a2,16
  const { bus, core } = makeCore([...store, ...load]);
  core.writeReg(2, 0x200);
  core.writeReg(8, 0xabcd);
  core.step(); // store
  eq("mem32[0x214] = a8", bus.read32(0x214), 0xabcd);
  bus.write32(0x210, 0x1234);
  core.step(); // load
  eq("a8 = mem32[0x210]", core.readReg(8), 0x1234);
}

// ── Test 3: branch BEQ (taken vs not-taken) ──────────────────────────────────
// beq a2,a3,+0  (37 12 00): target = pc+4 when a2==a3, else pc+3.
{
  // not taken
  let { core } = makeCore([0x37,0x12,0x00]);
  core.writeReg(2, 1); core.writeReg(3, 2);
  core.step();
  eq("BEQ not-taken pc", core.pc, 3);
  // taken
  ({ core } = makeCore([0x37,0x12,0x00]));
  core.writeReg(2, 7); core.writeReg(3, 7);
  core.step();
  eq("BEQ taken pc", core.pc, 4);
}

// ── Test 4: J ────────────────────────────────────────────────────────────────
// j +0 (06 00 00): target = pc+4.
{
  const { core } = makeCore([0x06,0x00,0x00]);
  core.step();
  eq("J pc", core.pc, 4);
}

// ── Test 5: logic + shifts (or, slli, srli) ──────────────────────────────────
// or a6,a3,a4 | slli a4,a3,4 | srli a5,a4,2   (a3=0x0f, a4=0x30)
{
  const prog = [0x40,0x63,0x20, 0xc0,0x43,0x11, 0x40,0x52,0x41];
  const { core } = makeCore(prog);
  core.writeReg(3, 0x0f);
  core.writeReg(4, 0x30);
  core.step(); // or  a6 = 0x0f | 0x30 = 0x3f
  core.step(); // slli a4 = 0x0f << 4 = 0xf0
  core.step(); // srli a5 = 0xf0 >>> 2 = 0x3c
  eq("a6 (or)",   core.readReg(6), 0x3f);
  eq("a4 (slli4)", core.readReg(4), 0xf0);
  eq("a5 (srli2)", core.readReg(5), 0x3c);
}

// ── Test 6: mov.n + nop.n ────────────────────────────────────────────────────
{
  const prog = [0x7d,0x02, 0x3d,0xf0]; // mov.n a7,a2 ; nop.n
  const { core } = makeCore(prog);
  core.writeReg(2, 0x1234);
  core.step(); core.step();
  eq("a7 (mov.n)", core.readReg(7), 0x1234);
  eq("pc after mov.n+nop.n", core.pc, 4);
}

// ── Test 7: zero-branches (beqz / bnez) ──────────────────────────────────────
{
  let { core } = makeCore([0x16,0x03,0x00]); // beqz a3
  core.writeReg(3, 0); core.step();
  eq("BEQZ taken (a3=0) pc", core.pc, 4);
  ({ core } = makeCore([0x16,0x03,0x00]));
  core.writeReg(3, 5); core.step();
  eq("BEQZ not-taken (a3=5) pc", core.pc, 3);
  ({ core } = makeCore([0x56,0x03,0x00])); // bnez a3
  core.writeReg(3, 5); core.step();
  eq("BNEZ taken (a3=5) pc", core.pc, 4);
}

// ── Test 8: byte load/store (s8i / l8ui) ─────────────────────────────────────
{
  const prog = [0x82,0x42,0x07, 0x82,0x02,0x03]; // s8i a8,a2,7 ; l8ui a8,a2,3
  const { bus, core } = makeCore(prog);
  core.writeReg(2, 0x300);
  core.writeReg(8, 0xab);
  core.step(); // store
  eq("mem8[0x307] = a8", bus.read8(0x307), 0xab);
  bus.write8(0x303, 0xcd);
  core.step(); // load
  eq("a8 = mem8[0x303]", core.readReg(8), 0xcd);
}

// ── Test 9: l32r (load 32-bit literal — how the GPIO addr gets loaded for M1) ─
{
  const bus = new SystemBus(0, 0x80001);
  bus.write32(0, 0x3ff44004 | 0); // literal at addr 0
  const at = 0x40000;
  [0x21, 0x00, 0x00].forEach((b, i) => bus.write8(at + i, b)); // l32r a2, (imm16=0)
  const core = new XtensaLX6Core(bus);
  core.reset();
  core.pc = at; // vaddr = ((at+3)&~3) - 0x40000 = 0
  core.step();
  eq("a2 (l32r GPIO addr)", core.readReg(2) >>> 0, 0x3ff44004);
}

// ── Test 10: windowed CALL8 / ENTRY / RETW.N rotation ────────────────────────
// Real windowed-ABI program (xtensa-esp32-elf, see docs/notes/xtensa-decode.md):
//   _start: movi a1,256; movi a2,111; movi.n a10,5; movi.n a11,7;
//           call8 func;  movi a4,222;  loop: j loop
//   func:   entry a1,32; add.n a2,a2,a3; retw.n
// call8 passes caller a10/a11 → callee a2/a3; func returns the sum in a2, which maps
// back to the caller's a10 after RETW unrotates. Every step hand-traced from the ISA.
{
  const prog = [
    0x12,0xa1,0x00, 0x22,0xa0,0x6f, 0x0c,0x5a, 0x0c,0x7b, 0xa5,0x00,0x00,
    0x42,0xa0,0xde, 0x06,0xff,0xff, 0x00, 0x36,0x41,0x00, 0x3a,0x22, 0x1d,0xf0,
  ];
  const { core } = makeCore(prog);
  core.step(); core.step(); core.step(); core.step(); // 4 setup movis
  eq("T10 setup a1", core.readReg(1), 256);
  eq("T10 setup a10", core.readReg(10), 5);
  eq("T10 setup a11", core.readReg(11), 7);
  // call8: latch CALLINC=2, stash a8=(2<<30)|ret, NO rotation yet, pc → func(0x14)
  core.step();
  eq("T10 call8 callInc", core.windowState().callInc, 2);
  eq("T10 call8 a8 incr-bits", core.readReg(8) >>> 30, 2);
  eq("T10 call8 a8 retaddr", core.readReg(8) & 0x3fffffff, 0x0d); // ret = 0x0a + 3
  eq("T10 call8 base unrotated", core.windowState().windowBase, 0);
  eq("T10 call8 pc→func", core.pc, 0x14);
  // entry: WindowBase += CALLINC(2), mark frame 2 live, new a1 = old a1 - 32
  core.step();
  eq("T10 entry windowBase", core.windowState().windowBase, 2);
  eq("T10 entry windowStart", core.windowState().windowStart, 0b101);
  eq("T10 entry new SP (a1@win2 = AR9)", core.readReg(9), 224);
  // add.n a2,a2,a3 in func's window → AR10 = 5 + 7 = 12
  core.step();
  eq("T10 add.n result", core.readReg(10), 12);
  // retw.n: unrotate to base 0, clear frame-2 bit, pc → ret(0x0d)
  core.step();
  eq("T10 retw windowBase", core.windowState().windowBase, 0);
  eq("T10 retw windowStart", core.windowState().windowStart, 0b001);
  eq("T10 retw pc→ret", core.pc, 0x0d);
  core.step(); // movi a4,222
  eq("T10 post-return a4", core.readReg(4), 222);
  core.step(); // j self
  eq("T10 j self-loop", core.pc, 0x10);
  eq("T10 final a2 preserved", core.readReg(2), 111); // caller marker survived the call
  eq("T10 final a10 = result", core.readReg(10), 12);
}

// ── Test 11: CALLX8 (register-indirect) + ENTRY + WIDE retw + literal-pool l32r ─
// The assembler relaxed call8 into l32r a8,<lit>; callx8 a8, so this covers the other
// return/call decode paths (op0=0 SNM0) in genuine toolchain output. _start at 0x04
// (a 4-byte literal holding func2's address sits at 0x00).
//   _start: movi a1,256; movi.n a10,9; movi.n a11,4;
//           l32r a8,func2; callx8 a8; movi a4,123; loop2: j loop2
//   func2:  entry a1,16; sub a2,a2,a3; retw   (wide)
{
  const prog = [
    0x18,0x00,0x00,0x00, 0x12,0xa1,0x00, 0x0c,0x9a, 0x0c,0x4b, 0x81,0xfd,0xff,
    0xe0,0x08,0x00, 0x42,0xa0,0x7b, 0x06,0xff,0xff, 0x00, 0x36,0x21,0x00,
    0x30,0x22,0xc0, 0x90,0x00,0x00,
  ];
  const { core } = makeCore(prog);
  core.pc = 0x04; // skip the literal word at 0x00
  core.step(); core.step(); core.step(); // movi a1 / movi.n a10 / movi.n a11
  core.step(); // l32r a8 ← mem32[0x00] = 0x18 (func2 addr)
  eq("T11 l32r a8 = func2 addr", core.readReg(8), 0x18);
  core.step(); // callx8 a8 → target read before a8 overwritten
  eq("T11 callx8 pc→func2", core.pc, 0x18);
  eq("T11 callx8 callInc", core.windowState().callInc, 2);
  eq("T11 callx8 a8 retaddr", core.readReg(8) & 0x3fffffff, 0x11); // ret = 0x0e + 3
  core.step(); // entry a1,16 → base 2, new SP = 256-16 = 240
  eq("T11 entry windowBase", core.windowState().windowBase, 2);
  eq("T11 entry new SP", core.readReg(9), 240);
  core.step(); // sub a2,a2,a3 → AR10 = 9 - 4 = 5
  eq("T11 sub result", core.readReg(10), 5);
  core.step(); // wide retw → base 0, pc → 0x11
  eq("T11 retw windowBase", core.windowState().windowBase, 0);
  eq("T11 retw pc→ret", core.pc, 0x11);
  core.step(); // movi a4,123
  eq("T11 post-return a4", core.readReg(4), 123);
}

console.log("");
console.log(fail === 0
  ? `M0 DECODE TEST PASS ✓  (${pass} assertions)`
  : `M0 DECODE TEST FAIL ✗  (${fail} failed, ${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
