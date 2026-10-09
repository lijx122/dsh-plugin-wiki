export interface RecallSnippet {
    sessionId: string;
    time: string;
    workspace: string;
    userText: string;
    assistantText: string;
}
export interface RecallResult {
    found: boolean;
    count: number;
    snippets: RecallSnippet[];
    text: string;
}
export interface RecallOptions {
    query?: string;
    since?: string;
    until?: string;
    workspace?: string;
    limit?: number;
}
/**
 * 解码 DSH 目录名中的 ~XXXX 十六进制 Unicode 转义字符
 * 例：--D-B~7AD9~8BFE~7A0B-~7533~8BBA~7CFB~7EDF~8BFE-- -> --D-B站课程-申论系统课--
 */
export declare function decodeWorkspaceDirName(name: string): string;
/**
 * 解析用户传入的时间/日期边界（支持 YYYY-MM-DD 或毫秒时间戳）
 */
export declare function parseDateBoundary(input?: string, isEnd?: boolean): number | undefined;
/**
 * 格式化毫秒时间戳为 YYYY-MM-DD HH:mm:ss 本地时间
 */
export declare function formatTimestamp(ms: number): string;
/**
 * 清洗用户提问文本，剔除系统提示注入、环境上下文与技能列表噪音
 */
export declare function cleanUserText(raw: string): string;
/**
 * 提取助手最终文本回复，忽略工具调用与推理数据
 */
export declare function cleanAssistantText(rawText: string, maxChars?: number): string;
export declare class SessionScanner {
    private sessionsRoot;
    constructor(sessionsRoot?: string);
    /**
     * 按时间或关键词定向检索历史会话切片（限制 1~5 段紧凑切片）
     */
    recall(options?: RecallOptions): Promise<RecallResult>;
    /**
     * 将单会话的 JSONL 行序列组装为问答轮次列表
     */
    private extractTurns;
    private parseRawUserContent;
    private parseRawAssistantContent;
}
