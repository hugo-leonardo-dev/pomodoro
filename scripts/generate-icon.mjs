/**
 * Gera o ícone do Pomodoro sem dependências externas:
 * um anel de timer em papel-creme sobre fundo escuro quente,
 * com marcador e ponteiro em coral (mesma linguagem do app).
 *
 * Saídas:
 *   build/icon.png      (512×512 — usado pelo electron-builder)
 *   build/icon.ico      (256×256 embutido em ICO — ícone de janela/executável)
 *   src/renderer/icon.ico (cópia para o BrowserWindow em dev)
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- desenho
const SIZE = 512;
const BG = [23, 19, 14]; // #17130E papel escuro
const INK = [237, 230, 216]; // #EDE6D8 creme
const ACCENT = [232, 98, 47]; // #E8622F coral

const cx = SIZE / 2;
const cy = SIZE / 2;
const R = 168; // raio do anel
const RING_W = 9; // meia-espessura do anel
const HAND_W = 11; // meia-espessura do ponteiro
const DOT_HALF = 17; // quadrado central
const MARK_HALF = 15; // marcador no topo do anel

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/** cobertura anti-aliased de uma faixa |d| <= half */
const band = (d, half) => clamp01(half + 0.5 - Math.abs(d));

/** distância ponto → segmento (ax,ay)-(bx,by) */
function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const len2 = abx * abx + aby * aby;
  const t = len2 === 0 ? 0 : clamp01((apx * abx + apy * aby) / len2);
  const qx = ax + abx * t;
  const qy = ay + aby * t;
  return Math.hypot(px - qx, py - qy);
}

function draw(size) {
  const scale = size / SIZE;
  const buf = Buffer.alloc(size * size * 4);
  // ponteiro: do centro até ~2h (para cima e à direita)
  const handAng = (-58 * Math.PI) / 180;
  const handLen = (R - 26) * scale;
  const hx = size / 2 + handLen * Math.cos(handAng);
  const hy = size / 2 + handLen * Math.sin(handAng);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - size / 2;
      const dy = y + 0.5 - size / 2;
      const r = Math.hypot(dx, dy);

      // anel
      let covInk = band(r - R * scale, RING_W * scale);

      // quadrado central (coral)
      const half = DOT_HALF * scale;
      const inDot = Math.abs(dx) <= half && Math.abs(dy) <= half;
      let covAcc = inDot ? 1 : 0;

      // marcador no topo do anel (12h) — coral sobre o creme
      const mh = MARK_HALF * scale;
      const mdx = Math.abs(dx);
      const mdy = Math.abs(dy + R * scale);
      if (mdx <= mh && mdy <= mh) covAcc = 1;

      // ponteiro (coral)
      const dh = distToSegment(x + 0.5, y + 0.5, size / 2, size / 2, hx, hy);
      covAcc = Math.max(covAcc, band(dh, HAND_W * scale));

      let c = BG;
      let cov = 0;
      if (covAcc > 0) {
        c = ACCENT;
        cov = covAcc;
      }
      if (covInk > cov) {
        c = INK;
        cov = covInk;
      }

      const i = (y * size + x) * 4;
      buf[i] = Math.round(c[0] * cov + BG[0] * (1 - cov));
      buf[i + 1] = Math.round(c[1] * cov + BG[1] * (1 - cov));
      buf[i + 2] = Math.round(c[2] * cov + BG[2] * (1 - cov));
      buf[i + 3] = 255;
    }
  }
  return buf;
}

// ---------------------------------------------------------------- PNG
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function encodePNG(rgba, size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------- ICO
function boxDownscale(rgba, from, to) {
  const f = from / to;
  const out = Buffer.alloc(to * to * 4);
  for (let y = 0; y < to; y++) {
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = Math.floor(y * f); sy < Math.floor((y + 1) * f); sy++) {
        for (let sx = Math.floor(x * f); sx < Math.floor((x + 1) * f); sx++) {
          const i = (sy * from + sx) * 4;
          r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; a += rgba[i + 3]; n++;
        }
      }
      const o = (y * to + x) * 4;
      out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n); out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

function encodeICO(png256) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // count
  const entry = Buffer.alloc(16);
  entry[0] = 0; // 256px
  entry[1] = 0;
  entry[2] = 0; // palette
  entry[3] = 0;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bpp
  entry.writeUInt32LE(png256.length, 8);
  entry.writeUInt32LE(22, 12); // offset
  return Buffer.concat([header, entry, png256]);
}

// ---------------------------------------------------------------- saída
const rgba512 = draw(SIZE);
const png512 = encodePNG(rgba512, SIZE);
const rgba256 = boxDownscale(rgba512, SIZE, 256);
const png256 = encodePNG(rgba256, 256);
const ico = encodeICO(png256);

mkdirSync(join(root, 'build'), { recursive: true });
writeFileSync(join(root, 'build', 'icon.png'), png512);
writeFileSync(join(root, 'build', 'icon.ico'), ico);
mkdirSync(join(root, 'src', 'renderer'), { recursive: true });
copyFileSync(join(root, 'build', 'icon.ico'), join(root, 'src', 'renderer', 'icon.ico'));
console.log('Ícones gerados: build/icon.png (512), build/icon.ico (256), src/renderer/icon.ico');
