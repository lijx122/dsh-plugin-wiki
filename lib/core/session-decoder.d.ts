declare module 'node:zlib' {
    function zstdDecompressSync(buf: Buffer | Uint8Array): Buffer;
}
export interface ZstdFrame {
    start: number;
    end: number;
}
export declare function scanZstdFrames(buffer: Buffer): ZstdFrame[];
export declare function decompressSessionZstd(buffer: Buffer): string;
