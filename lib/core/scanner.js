import { existsSync, watch } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parseWikiDoc } from './parser.js';
const CACHE_VERSION = 1;
const CACHE_DIR = '.wiki';
const CACHE_FILE = 'cache.json';
const IGNORED_DIRS = new Set(['.wiki', '.git', '.dsh', 'node_modules', '.obsidian', '.vscode']);
export class WikiScanner {
    wikiRoot;
    cache = { version: CACHE_VERSION, entries: {} };
    docs = new Map();
    watcher = null;
    debounceTimer = null;
    constructor(wikiRoot) {
        this.wikiRoot = wikiRoot;
    }
    /**
     * 初始化扫描并加载/构建索引
     */
    async scan() {
        await this.ensureWikiDir();
        await this.loadCache();
        const mdFiles = await this.collectMarkdownFiles(this.wikiRoot);
        const currentPaths = new Set();
        for (const absPath of mdFiles) {
            const relPath = relative(this.wikiRoot, absPath).replace(/\\/g, '/');
            currentPaths.add(relPath);
            const fileStat = await stat(absPath);
            const cached = this.cache.entries[relPath];
            if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.sizeBytes === fileStat.size) {
                this.docs.set(relPath, cached.doc);
            }
            else {
                const content = await readFile(absPath, 'utf8');
                const doc = parseWikiDoc(relPath, absPath, content, fileStat.mtimeMs, fileStat.size);
                this.docs.set(relPath, doc);
                this.cache.entries[relPath] = {
                    mtimeMs: fileStat.mtimeMs,
                    sizeBytes: fileStat.size,
                    doc,
                };
            }
        }
        // 清理已删除的文件缓存
        for (const relPath of Object.keys(this.cache.entries)) {
            if (!currentPaths.has(relPath)) {
                delete this.cache.entries[relPath];
                this.docs.delete(relPath);
            }
        }
        await this.saveCache();
        return Array.from(this.docs.values());
    }
    getDocs() {
        return Array.from(this.docs.values());
    }
    getDoc(relPath) {
        const normalized = relPath.replace(/\\/g, '/');
        return this.docs.get(normalized);
    }
    /**
     * 开启目录变动监听
     */
    startWatch(onUpdated) {
        if (this.watcher)
            return;
        try {
            this.watcher = watch(this.wikiRoot, { recursive: true }, (_eventType, filename) => {
                if (!filename)
                    return;
                const normalized = filename.replace(/\\/g, '/');
                if (normalized.startsWith('.wiki') || normalized.startsWith('.git') || !normalized.endsWith('.md')) {
                    return;
                }
                if (this.debounceTimer)
                    clearTimeout(this.debounceTimer);
                this.debounceTimer = setTimeout(async () => {
                    try {
                        const docs = await this.scan();
                        onUpdated(docs);
                    }
                    catch {
                        // 防御静默降级
                    }
                }, 300);
            });
        }
        catch {
            // 某些系统或网络盘可能不支持递归 watch，平稳降级
        }
    }
    stopWatch() {
        if (this.watcher) {
            this.watcher.close();
            this.watcher = null;
        }
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
    }
    async ensureWikiDir() {
        if (!existsSync(this.wikiRoot)) {
            await mkdir(this.wikiRoot, { recursive: true });
        }
        const metaDir = join(this.wikiRoot, CACHE_DIR);
        if (!existsSync(metaDir)) {
            await mkdir(metaDir, { recursive: true });
        }
    }
    async loadCache() {
        const cachePath = join(this.wikiRoot, CACHE_DIR, CACHE_FILE);
        if (!existsSync(cachePath))
            return;
        try {
            const data = await readFile(cachePath, 'utf8');
            const parsed = JSON.parse(data);
            if (parsed && parsed.version === CACHE_VERSION && parsed.entries) {
                this.cache = parsed;
            }
        }
        catch {
            this.cache = { version: CACHE_VERSION, entries: {} };
        }
    }
    async saveCache() {
        const cachePath = join(this.wikiRoot, CACHE_DIR, CACHE_FILE);
        try {
            await writeFile(cachePath, JSON.stringify(this.cache, null, 2), 'utf8');
        }
        catch {
            // 缓存写失败不影响主流程运行
        }
    }
    async collectMarkdownFiles(dir) {
        const files = [];
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory()) {
                    if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) {
                        continue;
                    }
                    const subFiles = await this.collectMarkdownFiles(join(dir, entry.name));
                    files.push(...subFiles);
                }
                else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
                    files.push(join(dir, entry.name));
                }
            }
        }
        catch {
            // 目录无权限时安全返回
        }
        return files;
    }
}
