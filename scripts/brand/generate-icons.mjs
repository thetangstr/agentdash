#!/usr/bin/env node
// AgentDash: regenerate the favicon / PWA icon set in ui/public/ from the
// AgentDash brand mark. The geometry below must match
// ui/src/components/brand/AgentDashMark.tsx (the one definition of the mark).
//
//   node scripts/brand/generate-icons.mjs
//
// Writes: favicon.svg, favicon.ico (16/32/48), favicon-16x16.png,
// favicon-32x32.png, apple-touch-icon.png (180, mark at 80% on cream), android-chrome-192x192.png,
// android-chrome-512x512.png, maskable-icon-512x512.png (mark at 80% on teal,
// arrow inside the maskable safe zone).
//
// Rasterizes with sharp (librsvg), resolved from the server workspace package,
// so `pnpm install` is the only prerequisite.
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const sharp = createRequire(path.join(repoRoot, "server/package.json"))("sharp");
const outDir = path.join(repoRoot, "ui/public");

const TEAL = "#0d9488";
const CREAM = "#faf9f5";
const TILE_PATH = "M14 4 H42 L60 22 V50 A10 10 0 0 1 50 60 H14 A10 10 0 0 1 4 50 V14 A10 10 0 0 1 14 4 Z";

function markGroup() {
  return [
    `<path d="${TILE_PATH}" fill="${TEAL}"/>`,
    `<g stroke="${CREAM}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round" fill="none">`,
    `<line x1="22" y1="42" x2="42" y2="22"/>`,
    `<polyline points="26,22 42,22 42,38"/>`,
    `</g>`,
  ].join("");
}

/** The bare mark on a transparent background (favicon, "any" purpose icons). */
function markSvg(px) {
  const size = px ? ` width="${px}" height="${px}"` : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"${size}>${markGroup()}</svg>\n`;
}

/**
 * The mark scaled to `ratio` of the canvas, centred on a full-bleed square of
 * `background`. Used where the platform masks or fills the icon itself, so
 * there is no transparent edge:
 *   - apple-touch-icon: cream, so iOS's rounded-square mask keeps the teal
 *     chamfered tile visible (iOS fills transparency with black otherwise);
 *   - maskable: teal, so any mask shape (circle, squircle) only ever cuts
 *     teal and the arrow stays inside the 80% safe zone.
 */
function paddedSvg(ratio, background) {
  const px = 512;
  const scale = ratio;
  const offset = (64 - 64 * scale) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${px}" height="${px}"><rect width="64" height="64" fill="${background}"/><g transform="translate(${offset} ${offset}) scale(${scale})">${markGroup()}</g></svg>`;
}

/** Rasterize a 64x64-viewBox SVG, supersampled 4x, then downscaled to px. */
async function png(svg, px) {
  return sharp(Buffer.from(svg), { density: 72 * 4 }).resize(px, px).png({ compressionLevel: 9 }).toBuffer();
}

const rasterMark = (px) => png(markSvg(Math.max(px, 64)), px);

/** A PNG-payload ICO (Vista+ format; every current browser reads it). */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, data } of images) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

async function main() {
  const out = (name, data) => writeFile(path.join(outDir, name), data);

  await out("favicon.svg", markSvg());

  const ico = [];
  for (const size of [16, 32, 48]) ico.push({ size, data: await rasterMark(size) });
  await out("favicon.ico", buildIco(ico));
  await out("favicon-16x16.png", ico[0].data);
  await out("favicon-32x32.png", ico[1].data);

  await out("android-chrome-192x192.png", await rasterMark(192));
  await out("android-chrome-512x512.png", await rasterMark(512));
  await out("apple-touch-icon.png", await png(paddedSvg(0.8, CREAM), 180));
  await out("maskable-icon-512x512.png", await png(paddedSvg(0.8, TEAL), 512));

  console.log(`wrote AgentDash icon set to ${path.relative(repoRoot, outDir)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
