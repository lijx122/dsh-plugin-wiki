export interface SessionLinkEntry {
    sessionId: string;
    workspace?: string;
    topics: string[];
    wikiRefs: string[];
    updatedAt: string;
}
export interface SessionLinksMap {
    [sessionId: string]: SessionLinkEntry;
}
export declare class SessionLinksIndex {
    private wikiRoot;
    private filePath;
    private map;
    private loaded;
    constructor(wikiRoot: string);
    /**
     * 初始化加载持久化索引
     */
    init(): Promise<void>;
    /**
     * 从磁盘加载 session-links.json
     */
    load(): Promise<void>;
    /**
     * 持久化到磁盘
     */
    save(): Promise<void>;
    /**
     * 登记会话与 Wiki 词条的双向关联
     */
    addLink(sessionId: string, wikiRef: string, topic?: string, workspace?: string): Promise<void>;
    /**
     * 根据 Topic 反查关联的 Session ID 列表
     */
    getSessionsByTopic(topic: string): string[];
    /**
     * 根据 Wiki 词条相对路径反查关联的 Session ID 列表
     */
    getSessionsByWikiRef(wikiRef: string): string[];
    /**
     * 根据 Session ID 获取关联的 Topics 和 WikiRefs
     */
    getWikiRefsBySession(sessionId: string): {
        topics: string[];
        wikiRefs: string[];
    } | null;
    /**
     * 获取当前全部索引映射 (只读/快照)
     */
    getAll(): SessionLinksMap;
}
