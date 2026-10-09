import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export class SessionLinksIndex {
    wikiRoot;
    filePath;
    map = {};
    loaded = false;
    constructor(wikiRoot) {
        this.wikiRoot = wikiRoot;
        this.filePath = join(wikiRoot, '.wiki', 'session-links.json');
    }
    /**
     * 初始化加载持久化索引
     */
    async init() {
        if (this.loaded)
            return;
        await this.load();
    }
    /**
     * 从磁盘加载 session-links.json
     */
    async load() {
        try {
            if (existsSync(this.filePath)) {
                const content = await readFile(this.filePath, 'utf8');
                this.map = JSON.parse(content || '{}');
            }
            else {
                this.map = {};
            }
        }
        catch {
            this.map = {};
        }
        this.loaded = true;
    }
    /**
     * 持久化到磁盘
     */
    async save() {
        try {
            const dir = join(this.wikiRoot, '.wiki');
            if (!existsSync(dir)) {
                await mkdir(dir, { recursive: true });
            }
            await writeFile(this.filePath, JSON.stringify(this.map, null, 2), 'utf8');
        }
        catch (err) {
            // 容错处理
        }
    }
    /**
     * 登记会话与 Wiki 词条的双向关联
     */
    async addLink(sessionId, wikiRef, topic, workspace) {
        if (!this.loaded) {
            await this.init();
        }
        if (!sessionId || typeof sessionId !== 'string')
            return;
        const cleanSessionId = sessionId.trim();
        const cleanRef = wikiRef.replace(/\\/g, '/').replace(/^\/+/, '').trim();
        let entry = this.map[cleanSessionId];
        if (!entry) {
            entry = {
                sessionId: cleanSessionId,
                workspace: workspace?.trim() || undefined,
                topics: [],
                wikiRefs: [],
                updatedAt: new Date().toISOString(),
            };
            this.map[cleanSessionId] = entry;
        }
        if (workspace && !entry.workspace) {
            entry.workspace = workspace.trim();
        }
        if (cleanRef && !entry.wikiRefs.includes(cleanRef)) {
            entry.wikiRefs.push(cleanRef);
        }
        if (topic && typeof topic === 'string') {
            const cleanTopic = topic.trim();
            if (cleanTopic && !entry.topics.includes(cleanTopic)) {
                entry.topics.push(cleanTopic);
            }
        }
        entry.updatedAt = new Date().toISOString();
        await this.save();
    }
    /**
     * 根据 Topic 反查关联的 Session ID 列表
     */
    getSessionsByTopic(topic) {
        if (!topic || typeof topic !== 'string')
            return [];
        const t = topic.trim().toLowerCase();
        const results = [];
        for (const [sid, entry] of Object.entries(this.map)) {
            const matched = entry.topics.some((item) => {
                const itemLower = item.toLowerCase();
                return itemLower === t || itemLower.includes(t) || t.includes(itemLower);
            });
            if (matched && !results.includes(sid)) {
                results.push(sid);
            }
        }
        return results;
    }
    /**
     * 根据 Wiki 词条相对路径反查关联的 Session ID 列表
     */
    getSessionsByWikiRef(wikiRef) {
        if (!wikiRef || typeof wikiRef !== 'string')
            return [];
        const cleanRef = wikiRef.replace(/\\/g, '/').replace(/^\/+/, '').trim().toLowerCase();
        const results = [];
        for (const [sid, entry] of Object.entries(this.map)) {
            const matched = entry.wikiRefs.some((r) => {
                const rClean = r.replace(/\\/g, '/').replace(/^\/+/, '').trim().toLowerCase();
                return rClean === cleanRef || rClean.includes(cleanRef) || cleanRef.includes(rClean);
            });
            if (matched && !results.includes(sid)) {
                results.push(sid);
            }
        }
        return results;
    }
    /**
     * 根据 Session ID 获取关联的 Topics 和 WikiRefs
     */
    getWikiRefsBySession(sessionId) {
        if (!sessionId || typeof sessionId !== 'string')
            return null;
        const sid = sessionId.trim();
        // 1. 精确匹配
        if (this.map[sid]) {
            return {
                topics: [...this.map[sid].topics],
                wikiRefs: [...this.map[sid].wikiRefs],
            };
        }
        // 2. 兼容 session_ 或 session- 前缀匹配
        for (const [k, entry] of Object.entries(this.map)) {
            const normK = k.replace(/^session[_-]/, '');
            const normTarget = sid.replace(/^session[_-]/, '');
            if (normK === normTarget) {
                return {
                    topics: [...entry.topics],
                    wikiRefs: [...entry.wikiRefs],
                };
            }
        }
        return null;
    }
    /**
     * 获取当前全部索引映射 (只读/快照)
     */
    getAll() {
        return { ...this.map };
    }
}
