import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { decompressSessionZstd } from './session-decoder.js';
/**
 * 解码 DSH 目录名中的 ~XXXX 十六进制 Unicode 转义字符
 * 例：--D-B~7AD9~8BFE~7A0B-~7533~8BBA~7CFB~7EDF~8BFE-- -> --D-B站课程-申论系统课--
 */
export function decodeWorkspaceDirName(name) {
    return name.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
/**
 * 解析用户传入的时间/日期边界（支持 YYYY-MM-DD 或毫秒时间戳）
 */
export function parseDateBoundary(input, isEnd = false) {
    if (!input || typeof input !== 'string')
        return undefined;
    const trimmed = input.trim();
    if (!trimmed)
        return undefined;
    if (/^\d{10,13}$/.test(trimmed)) {
        const num = Number(trimmed);
        return trimmed.length === 10 ? num * 1000 : num;
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        const [y, m, d] = trimmed.split('-').map(Number);
        if (isEnd) {
            return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
        }
        return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    }
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed))
        return parsed;
    return undefined;
}
/**
 * 格式化毫秒时间戳为 YYYY-MM-DD HH:mm:ss 本地时间
 */
export function formatTimestamp(ms) {
    if (!ms || Number.isNaN(ms))
        return '未知时间';
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
/**
 * 清洗用户提问文本，剔除系统提示注入、环境上下文与技能列表噪音
 */
export function cleanUserText(raw) {
    if (!raw)
        return '';
    let cleaned = raw;
    // 1. 去除 system-reminder
    cleaned = cleaned.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '');
    // 2. 去除 environment_context
    cleaned = cleaned.replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '');
    // 3. 去除 Current runtime context 注入
    cleaned = cleaned.replace(/Current runtime context[\s\S]*/gi, '');
    // 4. 去除 Instructions from
    cleaned = cleaned.replace(/Instructions from:[\s\S]*/gi, '');
    // 5. 去除 记忆档案 注入
    cleaned = cleaned.replace(/### (?:个人长期 Wiki 认知档案|Agent 记忆档案)[\s\S]*/gi, '');
    // 6. 去除 skill 列表
    cleaned = cleaned.replace(/<available_skills>[\s\S]*?<\/available_skills>/gi, '');
    // 7. 去除 DSH 轮次时间采样元数据 (Time sampled while preparing turn...)
    cleaned = cleaned.replace(/Time sampled while preparing turn[\s\S]*?(?:Elapsed since[^\n]*\n?|$)/gi, '');
    return cleaned.trim();
}
/**
 * 提取助手最终文本回复，忽略工具调用与推理数据，控制在 300~500 字内
 */
export function cleanAssistantText(rawText, maxChars = 400) {
    const trimmed = rawText.trim();
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${trimmed.slice(0, maxChars)}...`;
}
export class SessionScanner {
    sessionsRoot;
    sessionLinks;
    constructor(sessionsRoot, sessionLinks) {
        this.sessionsRoot = sessionsRoot || join(homedir(), '.dsh', 'sessions');
        this.sessionLinks = sessionLinks;
    }
    /**
     * 按主题、精准会话ID、多关键词或时间范围定向检索历史会话切片（限制 1~5 段紧凑切片）
     */
    async recall(options = {}) {
        if (!existsSync(this.sessionsRoot)) {
            return {
                found: false,
                count: 0,
                snippets: [],
                text: '未找到历史会话记录（会话根目录不存在）。',
            };
        }
        const maxLimit = Math.min(5, Math.max(1, typeof options.limit === 'number' ? options.limit : 2));
        const sinceMs = parseDateBoundary(options.since, false);
        const untilMs = parseDateBoundary(options.until, true);
        const wsFilterLower = options.workspace?.trim().toLowerCase();
        // 构建有效多关键词列表
        const effectiveKeywords = [];
        if (Array.isArray(options.keywords)) {
            for (const kw of options.keywords) {
                if (typeof kw === 'string' && kw.trim()) {
                    const kwLower = kw.trim().toLowerCase();
                    if (!effectiveKeywords.includes(kwLower)) {
                        effectiveKeywords.push(kwLower);
                    }
                }
            }
        }
        if (typeof options.query === 'string' && options.query.trim()) {
            const qLower = options.query.trim().toLowerCase();
            if (!effectiveKeywords.includes(qLower)) {
                effectiveKeywords.push(qLower);
            }
        }
        // 确定是否启用精准目标会话过滤
        const targetSessionIdSet = new Set();
        let topicMatched = false;
        // 1. 若指定了 sessionId，直接加入目标集
        if (typeof options.sessionId === 'string' && options.sessionId.trim()) {
            const rawSid = options.sessionId.trim();
            const cleanSid = rawSid.replace(/^session[_-]/, '');
            targetSessionIdSet.add(rawSid);
            targetSessionIdSet.add(cleanSid);
            targetSessionIdSet.add(`session_${cleanSid}`);
            targetSessionIdSet.add(`session-${cleanSid}`);
        }
        // 2. 若指定了 topic，优先通过 sessionLinks 反查关联 sessionId
        if (typeof options.topic === 'string' && options.topic.trim()) {
            const topicStr = options.topic.trim();
            if (this.sessionLinks) {
                const foundSids = this.sessionLinks.getSessionsByTopic(topicStr);
                if (foundSids.length > 0) {
                    topicMatched = true;
                    for (const s of foundSids) {
                        const cleanS = s.replace(/^session[_-]/, '');
                        targetSessionIdSet.add(s);
                        targetSessionIdSet.add(cleanS);
                        targetSessionIdSet.add(`session_${cleanS}`);
                        targetSessionIdSet.add(`session-${cleanS}`);
                    }
                }
            }
            // 若没有反查到，或者没有命中索引，将 topic 作为关键词降级兜底全局搜索
            if (!topicMatched && effectiveKeywords.length === 0) {
                effectiveKeywords.push(topicStr.toLowerCase());
            }
        }
        // 3. 第一级剪枝：扫描工作区目录
        let wsDirNames = [];
        try {
            const allEntries = await readdir(this.sessionsRoot, { withFileTypes: true });
            wsDirNames = allEntries
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
        }
        catch {
            return {
                found: false,
                count: 0,
                snippets: [],
                text: '读取历史会话目录失败。',
            };
        }
        if (wsFilterLower) {
            wsDirNames = wsDirNames.filter((dir) => {
                const decoded = decodeWorkspaceDirName(dir).toLowerCase();
                return decoded.includes(wsFilterLower) || dir.toLowerCase().includes(wsFilterLower);
            });
        }
        if (wsDirNames.length === 0) {
            return {
                found: false,
                count: 0,
                snippets: [],
                text: `未找到匹配的工作区会话${options.workspace ? `（工作区: "${options.workspace}"）` : ''}。`,
            };
        }
        // 4. 第二级剪枝：收集候选会话文件
        let candidates = [];
        for (const wsDir of wsDirNames) {
            const wsPath = join(this.sessionsRoot, wsDir);
            let sessionDirs = [];
            try {
                const entries = await readdir(wsPath, { withFileTypes: true });
                sessionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
            }
            catch {
                continue;
            }
            for (const sDir of sessionDirs) {
                // 如果限定了目标 session 集合，进行快速前置过滤
                if (targetSessionIdSet.size > 0) {
                    const sDirClean = sDir.replace(/^session[_-]/, '');
                    const matches = targetSessionIdSet.has(sDir) || targetSessionIdSet.has(sDirClean);
                    if (!matches) {
                        continue;
                    }
                }
                const sessionPath = join(wsPath, sDir);
                const v4Zstd = join(sessionPath, 'session.v4.jsonl.zstd');
                const v3Zstd = join(sessionPath, 'session.v3.jsonl.zstd');
                const plainZstd = join(sessionPath, 'session.jsonl.zstd');
                const jsonlPath = join(sessionPath, 'session.jsonl');
                let targetFile = null;
                let isZstd = false;
                if (existsSync(v4Zstd)) {
                    targetFile = v4Zstd;
                    isZstd = true;
                }
                else if (existsSync(v3Zstd)) {
                    targetFile = v3Zstd;
                    isZstd = true;
                }
                else if (existsSync(plainZstd)) {
                    targetFile = plainZstd;
                    isZstd = true;
                }
                else if (existsSync(jsonlPath)) {
                    targetFile = jsonlPath;
                    isZstd = false;
                }
                if (!targetFile)
                    continue;
                try {
                    const fileStat = await stat(targetFile);
                    // 若传了 since 且文件最后修改时间早于 since，直接剪枝跳过
                    if (sinceMs !== undefined && fileStat.mtimeMs < sinceMs) {
                        continue;
                    }
                    candidates.push({
                        filePath: targetFile,
                        sessionId: sDir,
                        wsDirName: wsDir,
                        mtimeMs: fileStat.mtimeMs,
                        isZstd,
                    });
                }
                catch { }
            }
        }
        // 按最新修改时间倒序排列
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        // 性能风控：若未限定精确目标、未指定 since 且未指定 workspace，默认扫描最近 120 个活跃会话
        if (targetSessionIdSet.size === 0 && sinceMs === undefined && !options.workspace) {
            candidates = candidates.slice(0, 120);
        }
        const snippets = [];
        // 5. 逐个会话文件抽取有效问答轮次
        for (const candidate of candidates) {
            if (snippets.length >= maxLimit)
                break;
            let fileBuffer;
            try {
                fileBuffer = await readFile(candidate.filePath);
            }
            catch {
                continue;
            }
            let contentStr = '';
            if (candidate.isZstd) {
                contentStr = decompressSessionZstd(fileBuffer);
            }
            else {
                contentStr = fileBuffer.toString('utf8');
            }
            if (!contentStr)
                continue;
            const lines = contentStr.split('\n');
            if (lines.length === 0)
                continue;
            // 解析首行 session 元数据
            let sessionCwd;
            let sessionCreatedAt;
            try {
                const firstObj = JSON.parse(lines[0] || '{}');
                if (firstObj.type === 'session') {
                    sessionCwd = firstObj.cwd;
                    sessionCreatedAt = firstObj.createdAt;
                }
            }
            catch { }
            // 若传了 until 且会话创建时间晚于 until，直接跳过整个会话
            if (untilMs !== undefined && sessionCreatedAt !== undefined && sessionCreatedAt > untilMs) {
                continue;
            }
            // 计算高可读工作区显示名称
            let readableWs = decodeWorkspaceDirName(candidate.wsDirName).replace(/^--|--$/g, '');
            if (sessionCwd) {
                const base = basename(sessionCwd);
                if (base && base !== '.' && base !== '/') {
                    readableWs = base;
                }
            }
            // 提取会话问答轮次
            const turns = this.extractTurns(lines);
            // 按轮次时间倒序匹配（优先返回会话中更新的提问）
            const reversedTurns = [...turns].reverse();
            // 获取双向链接关联信息
            let relatedWikiStr = '无';
            if (this.sessionLinks) {
                const linkInfo = this.sessionLinks.getWikiRefsBySession(candidate.sessionId);
                if (linkInfo) {
                    const parts = [...linkInfo.topics, ...linkInfo.wikiRefs];
                    if (parts.length > 0) {
                        relatedWikiStr = parts.join(', ');
                    }
                }
            }
            const formattedSessionId = candidate.sessionId.startsWith('session_')
                ? candidate.sessionId
                : candidate.sessionId.startsWith('session-')
                    ? 'session_' + candidate.sessionId.slice(8)
                    : `session_${candidate.sessionId}`;
            for (const turn of reversedTurns) {
                if (snippets.length >= maxLimit)
                    break;
                // 时间过滤
                if (sinceMs !== undefined && turn.timeMs < sinceMs)
                    continue;
                if (untilMs !== undefined && turn.timeMs > untilMs)
                    continue;
                // 关键词过滤（命中任一词即可）
                if (effectiveKeywords.length > 0) {
                    const uLower = turn.userText.toLowerCase();
                    const aLower = turn.assistantText.toLowerCase();
                    const matched = effectiveKeywords.some((kw) => uLower.includes(kw) || aLower.includes(kw));
                    if (!matched)
                        continue;
                }
                const snippet = {
                    sessionId: formattedSessionId,
                    time: formatTimestamp(turn.timeMs),
                    workspace: readableWs,
                    userText: turn.userText.length > 500 ? `${turn.userText.slice(0, 500)}...` : turn.userText,
                    assistantText: cleanAssistantText(turn.assistantText, 400),
                    relatedWiki: relatedWikiStr,
                };
                snippets.push(snippet);
            }
        }
        if (snippets.length === 0) {
            let filterDesc = '';
            if (options.topic)
                filterDesc += `（主题: "${options.topic}"）`;
            if (options.sessionId)
                filterDesc += `（会话: "${options.sessionId}"）`;
            if (effectiveKeywords.length > 0)
                filterDesc += `（关键词: [${effectiveKeywords.join(', ')}]）`;
            return {
                found: false,
                count: 0,
                snippets: [],
                text: `未在历史会话中找到匹配切片${filterDesc}。`,
            };
        }
        // 输出格式严格对齐用户规范：
        // 来源：<YYYY-MM-DD HH:mm:ss> session_<sessionId> (工作区: <workspace>)
        // 关联Wiki: <topics/wikiRefs...>
        // 上下文：
        // 用户：<用户问题>
        // 回答：<最终结论 (300~500字截断)>
        const textPieces = snippets.map((s) => {
            return [
                `来源：${s.time} ${s.sessionId} (工作区: ${s.workspace})`,
                `关联Wiki: ${s.relatedWiki || '无'}`,
                `上下文：`,
                `用户：${s.userText}`,
                `回答：${s.assistantText}`,
            ].join('\n');
        });
        return {
            found: true,
            count: snippets.length,
            snippets,
            text: textPieces.join('\n\n'),
        };
    }
    /**
     * 将单会话的 JSONL 行序列组装为问答轮次列表
     */
    extractTurns(lines) {
        const turns = [];
        let currentTurn = null;
        for (const line of lines) {
            if (!line.trim())
                continue;
            let obj;
            try {
                obj = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (obj.type === 'user/message') {
                const uText = this.parseRawUserContent(obj.data);
                const cleaned = cleanUserText(uText);
                if (!cleaned)
                    continue;
                // 若上一轮已有完整问答或已有提问，则归档开启新轮
                if (currentTurn && (currentTurn.assistantText || currentTurn.userText)) {
                    turns.push(currentTurn);
                    currentTurn = null;
                }
                const timeMs = obj.time || obj.data?.time || 0;
                currentTurn = {
                    userText: cleaned,
                    assistantText: '',
                    timeMs,
                };
            }
            else if (obj.type === 'assistant/message') {
                const aText = this.parseRawAssistantContent(obj.data);
                if (!aText)
                    continue;
                if (currentTurn) {
                    // 在同一轮内，若后续有更完整/更新的回复则更新之
                    currentTurn.assistantText = aText;
                    if (obj.time) {
                        currentTurn.timeMs = obj.time;
                    }
                }
            }
        }
        if (currentTurn && currentTurn.userText) {
            turns.push(currentTurn);
        }
        return turns;
    }
    parseRawUserContent(data) {
        const content = data?.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        }
        else if (Array.isArray(content)) {
            for (const item of content) {
                if (typeof item === 'string') {
                    text += item + ' ';
                }
                else if (item && typeof item === 'object') {
                    if (item.type === 'text' && typeof item.text === 'string') {
                        text += item.text + ' ';
                    }
                }
            }
        }
        else if (data?.message?.content) {
            return this.parseRawUserContent(data.message);
        }
        return text;
    }
    parseRawAssistantContent(data) {
        const msg = data?.message || data;
        const content = msg?.content;
        let text = '';
        if (typeof content === 'string') {
            text = content;
        }
        else if (Array.isArray(content)) {
            for (const item of content) {
                if (typeof item === 'string') {
                    text += item + ' ';
                }
                else if (item && typeof item === 'object') {
                    if (item.type === 'text' && typeof item.text === 'string') {
                        text += item.text + ' ';
                    }
                }
            }
        }
        return text.trim();
    }
}
