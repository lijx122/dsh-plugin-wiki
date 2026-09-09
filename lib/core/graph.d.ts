import type { WikiDoc } from '../types.js';
export declare class WikiGraph {
    private forwardMap;
    private backMap;
    private nameToRelPath;
    build(docs: WikiDoc[]): void;
    resolveReference(ref: string): string | undefined;
    getForwardLinks(relPath: string): string[];
    getBackLinks(relPath: string): string[];
    exportAdjacency(): Record<string, string[]>;
}
