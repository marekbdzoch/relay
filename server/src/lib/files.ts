import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { config } from '../config.ts';
import { HttpError, randomToken } from './util.ts';

/** Reads width/height from PNG, GIF, JPEG and WebP headers. */
export function imageSize(file: string): { width: number; height: number } | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const kind = b.toString('ascii', 12, 16);
      if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (kind === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
    }
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1];
        const len = b.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        }
        i += 2 + len;
      }
    }
  } catch {
    /* ignore */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

const SAFE_INLINE = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/(mp4|webm|ogg|quicktime)|audio\/.+|application\/pdf|text\/plain)$/;
export const isSafeInline = (mime: string) => SAFE_INLINE.test(mime);

/** Streams an uploaded part to disk; returns the relative path and size. */
export async function saveUpload(part: MultipartFile, subdir: string) {
  const dir = path.join(config.uploadsDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  const ext = path.extname(part.filename || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
  const name = `${Date.now().toString(36)}${randomToken(9)}${ext}`;
  const abs = path.join(dir, name);
  await pipeline(part.file, fs.createWriteStream(abs));
  if (part.file.truncated) {
    fs.rmSync(abs, { force: true });
    throw new HttpError(413, 'file_too_large');
  }
  const size = fs.statSync(abs).size;
  return { rel: path.join(subdir, name), abs, size };
}

export function absPath(rel: string) {
  const abs = path.resolve(config.uploadsDir, rel);
  if (!abs.startsWith(config.uploadsDir)) throw new HttpError(400, 'bad_path');
  return abs;
}

export function removeUpload(rel: string | null | undefined) {
  if (!rel) return;
  try {
    fs.rmSync(absPath(rel), { force: true });
  } catch {
    /* ignore */
  }
}
