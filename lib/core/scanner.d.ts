import type { WikiDoc } from '../types.js';
export declare class WikiScanner {
    readonly wikiRoot: string;
    private cache;
    private docs;
    private watcher;
    private debounceTimer;
    constructor(wikiRoot: string);
    /**
     * 初始化扫描并加载/构建索引
     */
    scan(): Promise<WikiDoc[]>;
    getDocs(): WikiDoc[];
    getDoc(relPath: string): WikiDoc | undefined;
    /**
     * 开启目录变动监听
     */
    startWatch(onUpdated: (docs: WikiDoc[]) => void): void;
    stopWatch(): void;
    private ensureWikiDir;
    private loadCache;
    private saveCache;
    private collectMarkdownFiles;
}
