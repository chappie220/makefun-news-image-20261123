import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourcePath = fileURLToPath(new URL('./entry.png', import.meta.url));
const image = readFileSync(sourcePath);

// Validate the complete PNG before it can become the submitted output.
function requireValid(condition, message) {
  if (!condition) throw new Error(`Invalid entry.png: ${message}`);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < 256; index++) {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

requireValid(image.length > 0 && image.length <= 1048576, 'size exceeds 1 MiB');
requireValid(image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'signature');
let offset = 8;
let sawHeader = false;
let sawPalette = false;
let sawData = false;
let sawEnd = false;
while (offset < image.length) {
  requireValid(offset + 12 <= image.length, 'truncated chunk header');
  const length = image.readUInt32BE(offset);
  const end = offset + 12 + length;
  requireValid(end <= image.length, 'truncated chunk payload');
  const kind = image.toString('ascii', offset + 4, offset + 8);
  const payload = image.subarray(offset + 8, end - 4);
  requireValid(crc32(image.subarray(offset + 4, end - 4)) === image.readUInt32BE(end - 4), `${kind} checksum`);
  requireValid(sawHeader || kind === 'IHDR', 'IHDR must be first');
  if (kind === 'IHDR') {
    requireValid(!sawHeader && offset === 8 && length === 13, 'IHDR structure');
    requireValid(payload.readUInt32BE(0) === 1024 && payload.readUInt32BE(4) === 1024, 'expected 1024 by 1024');
    requireValid(payload[8] === 8 && payload[9] === 3, 'expected 8-bit palette PNG');
    requireValid(payload[10] === 0 && payload[11] === 0 && payload[12] === 0, 'unsupported encoding');
    sawHeader = true;
  } else if (kind === 'PLTE') {
    requireValid(!sawPalette && !sawData && length === 768, 'expected 256-color palette before IDAT');
    sawPalette = true;
  } else if (kind === 'IDAT') {
    requireValid(sawPalette, 'missing palette');
    sawData = true;
  } else if (kind === 'IEND') {
    requireValid(length === 0 && sawData && end === image.length, 'incomplete image or trailing bytes');
    sawEnd = true;
  }
  offset = end;
}
requireValid(sawHeader && sawPalette && sawData && sawEnd, 'missing required chunk');

// Environment input is used only as a path, never as executable content.
const outputDirectory = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output');
mkdirSync(outputDirectory, { recursive: true });
const destination = join(outputDirectory, 'entry.png');
const temporary = join(outputDirectory, 'entry.png.tmp');
let ownsTemporary = false;
try {
  // Exclusive creation avoids following an existing temporary symlink.
  writeFileSync(temporary, image, { flag: 'wx', mode: 0o644 });
  ownsTemporary = true;
  renameSync(temporary, destination);
  ownsTemporary = false;
} finally {
  if (ownsTemporary) unlinkSync(temporary);
}
