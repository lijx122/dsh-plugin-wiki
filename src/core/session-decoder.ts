import { zstdDecompressSync } from 'node:zlib';

declare module 'node:zlib' {
  export function zstdDecompressSync(buf: Buffer | Uint8Array): Buffer;
}

const ZSTD_MAGIC = 0xFD2FB528;

export interface ZstdFrame {
  start: number;
  end: number;
}

export function scanZstdFrames(buffer: Buffer): ZstdFrame[] {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset >= buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const singleSegment = (descriptor & 32) !== 0;
    const contentSizeFlag = descriptor >>> 6;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;

    let lastBlock = false;
    while (!lastBlock && offset < buffer.length) {
      if (buffer.length - offset < 3) break;
      const b0 = buffer[offset]!;
      const b1 = buffer[offset + 1]!;
      const b2 = buffer[offset + 2]!;
      offset += 3;
      lastBlock = (b0 & 1) !== 0;
      const blockType = (b0 >>> 1) & 3;
      const blockSize = (b0 >>> 3) | (b1 << 5) | (b2 << 13);
      if (blockType === 1) { // RLE
        offset += 1;
      } else {
        offset += blockSize;
      }
    }
    const checksum = (descriptor & 4) !== 0;
    if (checksum && offset + 4 <= buffer.length) {
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

export function decompressSessionZstd(buffer: Buffer): string {
  const frames = scanZstdFrames(buffer);
  if (frames.length === 0) {
    try {
      return zstdDecompressSync(buffer).toString('utf8');
    } catch {
      return buffer.toString('utf8');
    }
  }
  let fullText = '';
  for (const { start, end } of frames) {
    try {
      fullText += zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    } catch {}
  }
  return fullText;
}
