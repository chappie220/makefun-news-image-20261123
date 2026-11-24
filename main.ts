import {
  readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync,
  lstatSync, realpathSync, openSync, closeSync, fstatSync, fchmodSync,
} from 'node:fs';
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
let dataEnded = false;
let dataBytes = 0;
let sawEnd = false;
while (offset < image.length) {
  requireValid(offset + 12 <= image.length, 'truncated chunk header');
  const length = image.readUInt32BE(offset);
  const end = offset + 12 + length;
  requireValid(end <= image.length, 'truncated chunk payload');
  const kind = image.toString('ascii', offset + 4, offset + 8);
  const payload = image.subarray(offset + 8, end - 4);
  requireValid(/^[A-Za-z]{4}$/.test(kind) && (image[offset + 6] & 32) === 0, 'invalid chunk type');
  requireValid(crc32(image.subarray(offset + 4, end - 4)) === image.readUInt32BE(end - 4), `${kind} checksum`);
  requireValid(sawHeader || kind === 'IHDR', 'IHDR must be first');
  requireValid(!sawEnd, 'chunk after IEND');
  if (sawData && kind !== 'IDAT') dataEnded = true;
  if (kind === 'IHDR') {
    requireValid(!sawHeader && offset === 8 && length === 13, 'IHDR structure');
    requireValid(payload.readUInt32BE(0) === 1024 && payload.readUInt32BE(4) === 1024, 'expected 1024 by 1024');
    requireValid(payload[8] === 8 && payload[9] === 3, 'expected 8-bit palette PNG');
    requireValid(payload[10] === 0 && payload[11] === 0 && payload[12] === 0, 'unsupported encoding');
    sawHeader = true;
  } else if (kind === 'PLTE') {
    requireValid(!sawPalette && !sawData, 'PLTE must occur once before IDAT');
    requireValid(length >= 3 && length <= 768 && length % 3 === 0, 'expected 1–256 palette entries');
    sawPalette = true;
  } else if (kind === 'IDAT') {
    requireValid(sawHeader && sawPalette, 'missing header or palette');
    requireValid(!dataEnded, 'IDAT chunks must be consecutive');
    dataBytes += length;
    sawData = true;
  } else if (kind === 'IEND') {
    requireValid(length === 0 && sawData && dataBytes > 0 && end === image.length, 'incomplete image or trailing bytes');
    sawEnd = true;
  } else {
    requireValid((image[offset + 4] & 32) !== 0, `unknown critical chunk ${kind}`);
  }
  offset = end;
}
requireValid(sawHeader && sawPalette && sawData && sawEnd, 'missing required chunk');

// Environment input is used only as a path, never as executable content.
const outputDirectory = resolve(process.env.MAKEFUN_OUTPUT_DIR || '/output');
mkdirSync(outputDirectory, { recursive: true });
const canonicalDirectory = realpathSync(outputDirectory);
const destination = join(canonicalDirectory, 'entry.png');
const temporary = join(canonicalDirectory, 'entry.png.tmp');
if (destination === realpathSync(sourcePath)) {
  throw new Error('Output directory must not overwrite the source asset');
}

function inspectPath(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

const existingDestination = inspectPath(destination);
if (existingDestination && !existingDestination.isFile()) {
  throw new Error('Output destination must be a regular file');
}
const staleTemporary = inspectPath(temporary);
if (staleTemporary) {
  // Never follow or remove a symlink, directory, or multiply linked file.
  if (!staleTemporary.isFile() || staleTemporary.nlink !== 1) {
    throw new Error('Unsafe temporary output path');
  }
  unlinkSync(temporary);
}

let descriptor;
let ownedTemporary;
try {
  // Record ownership before writing, so even a partial write gets cleaned up.
  descriptor = openSync(temporary, 'wx', 0o644);
  ownedTemporary = fstatSync(descriptor);
  writeFileSync(descriptor, image);
  fchmodSync(descriptor, 0o644);
  closeSync(descriptor);
  descriptor = undefined;
  renameSync(temporary, destination);
  ownedTemporary = undefined;
} finally {
  try {
    if (descriptor !== undefined) closeSync(descriptor);
  } finally {
    if (ownedTemporary) {
      const remaining = inspectPath(temporary);
      if (remaining && remaining.dev === ownedTemporary.dev && remaining.ino === ownedTemporary.ino) {
        unlinkSync(temporary);
      }
    }
  }
}
