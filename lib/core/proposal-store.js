import { existsSync, statSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
const PROPOSALS_FILE = 'proposals.json';
const BACKUP_DIR = 'backups';
const META_DIR = '.wiki';
export class ProposalStore {
    wikiRoot;
    proposals = new Map();
    lastMtimeMs = 0;
    constructor(wikiRoot) {
        this.wikiRoot = wikiRoot;
    }
    ensureDiskSynced() {
        const filePath = join(this.wikiRoot, META_DIR, PROPOSALS_FILE);
        if (!existsSync(filePath)) {
            if (this.proposals.size > 0) {
                this.proposals.clear();
                this.lastMtimeMs = 0;
            }
            return;
        }
        try {
            const s = statSync(filePath);
            if (s.mtimeMs !== this.lastMtimeMs) {
                const data = readFileSync(filePath, 'utf8');
                const list = JSON.parse(data);
                this.proposals.clear();
                for (const p of list) {
                    this.proposals.set(p.id, p);
                }
                this.lastMtimeMs = s.mtimeMs;
            }
        } catch {
            // 安全容错
        }
    }
    async init() {
        await this.ensureDirs();
        this.ensureDiskSynced();
    }
    async createProposal(params) {
        this.ensureDiskSynced();
        const id = this.generateShortId();
        const proposal = {
            id,
            createdAt: Date.now(),
            type: params.type,
            targetRelPath: params.targetRelPath.replace(/\\/g, '/'),
            title: params.title,
            section: params.section,
            content: params.content,
            reason: params.reason,
            confidence: Math.max(0, Math.min(1, params.confidence)),
            status: 'pending',
            entityType: params.entityType,
        };
        this.proposals.set(id, proposal);
        await this.save();
        return proposal;
    }
    getProposal(id) {
        this.ensureDiskSynced();
        return this.proposals.get(id);
    }
    listPending() {
        this.ensureDiskSynced();
        return Array.from(this.proposals.values())
            .filter((p) => p.status === 'pending')
            .sort((a, b) => b.createdAt - a.createdAt);
    }
    listAll() {
        this.ensureDiskSynced();
        return Array.from(this.proposals.values()).sort((a, b) => b.createdAt - a.createdAt);
    }
    /**
     * 批准并应用提案（执行安全合并与历史自动备份）
     */
    async approve(id) {
        this.ensureDiskSynced();
        const proposal = this.proposals.get(id);
        if (!proposal) {
            return { ok: false, message: `提案 ${id} 不存在`, targetPath: '' };
        }
        if (proposal.status !== 'pending') {
            return { ok: false, message: `提案 ${id} 已经是 ${proposal.status} 状态，不能重复审批`, targetPath: proposal.targetRelPath };
        }
        const absTarget = join(this.wikiRoot, proposal.targetRelPath);
        // 路径防穿透检查
        if (!absTarget.startsWith(this.wikiRoot)) {
            return { ok: false, message: '安全阻断：目标路径超出 Wiki 根目录', targetPath: proposal.targetRelPath };
        }
        await mkdir(dirname(absTarget), { recursive: true });
        // 1. 如果文件已存在，先做备份
        if (existsSync(absTarget)) {
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const safeName = proposal.targetRelPath.replace(/[\/\\]/g, '__');
            const backupPath = join(this.wikiRoot, META_DIR, BACKUP_DIR, `${ts}_${safeName}`);
            await copyFile(absTarget, backupPath);
        }
        // 2. 执行合并写入
        if (!existsSync(absTarget)) {
            // 全新文件创建，推导准确的词条类型
            const resolvedType = proposal.entityType
                || (proposal.type === 'record_decision' ? 'decision' : '')
                || proposal.targetRelPath.split('/')[0].toLowerCase().replace(/s$/, '')
                || 'general';
            const frontmatter = [
                '---',
                `title: "${proposal.title.replace(/"/g, '\\"')}"`,
                `type: "${resolvedType}"`,
                'status: "active"',
                `updated: "${new Date().toISOString().slice(0, 10)}"`,
                '---',
                '',
                `# ${proposal.title}`,
                '',
                proposal.content.trim(),
                '',
            ].join('\n');
            await writeFile(absTarget, frontmatter, 'utf8');
        }
        else {
            // 既有文件追加或合并
            const existing = await readFile(absTarget, 'utf8');
            const updated = this.mergeSection(existing, proposal.section, proposal.content);
            await writeFile(absTarget, updated, 'utf8');
        }
        proposal.status = 'applied';
        proposal.appliedAt = Date.now();
        await this.save();
        return {
            ok: true,
            message: `提案 ${id} 已批准并成功写入 ${proposal.targetRelPath}`,
            targetPath: proposal.targetRelPath,
        };
    }
    /**
     * 拒绝提案
     */
    async reject(id) {
        this.ensureDiskSynced();
        const proposal = this.proposals.get(id);
        if (!proposal) {
            return { ok: false, message: `提案 ${id} 不存在` };
        }
        if (proposal.status !== 'pending') {
            return { ok: false, message: `提案 ${id} 状态为 ${proposal.status}，不可重复操作` };
        }
        proposal.status = 'rejected';
        proposal.rejectedAt = Date.now();
        await this.save();
        return { ok: true, message: `提案 ${id} 已拒绝` };
    }
    mergeSection(original, sectionTitle, contentToAppend = '') {
        const trimmedAppend = contentToAppend.trim();
        if (!sectionTitle || !sectionTitle.trim()) {
            return `${original.trimEnd()}\n\n${trimmedAppend}\n`;
        }
        const headingRegex = new RegExp(`(^#{2,4})\\s+${escapeRegex(sectionTitle.trim())}\\s*$`, 'm');
        const match = headingRegex.exec(original);
        if (!match) {
            // 不存在该节，直接在文末增加
            return `${original.trimEnd()}\n\n## ${sectionTitle.trim()}\n\n${trimmedAppend}\n`;
        }
        // 匹配当前层级（比如 ## 为 2），遇到同级或更高级标题（<= level）才算小节结束
        const level = match[1].length;
        const matchIndex = match.index + match[0].length;
        const rest = original.slice(matchIndex);
        const nextHeadingRegex = new RegExp(`^#{1,${level}}\\s+`, 'm');
        const nextHeadingMatch = nextHeadingRegex.exec(rest);
        if (!nextHeadingMatch) {
            return `${original.trimEnd()}\n\n${trimmedAppend}\n`;
        }
        const insertIndex = matchIndex + nextHeadingMatch.index;
        const before = original.slice(0, insertIndex).trimEnd();
        const after = original.slice(insertIndex).trimStart();
        return `${before}\n\n${trimmedAppend}\n\n${after}`;
    }
    generateShortId() {
        const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
        let rand = '';
        for (let i = 0; i < 4; i++) {
            rand += chars[Math.floor(Math.random() * chars.length)];
        }
        return `prop-${rand}`;
    }
    async ensureDirs() {
        const meta = join(this.wikiRoot, META_DIR);
        const backup = join(meta, BACKUP_DIR);
        if (!existsSync(backup)) {
            await mkdir(backup, { recursive: true });
        }
    }
    async load() {
        const filePath = join(this.wikiRoot, META_DIR, PROPOSALS_FILE);
        if (!existsSync(filePath))
            return;
        try {
            const data = await readFile(filePath, 'utf8');
            const list = JSON.parse(data);
            this.proposals.clear();
            for (const p of list) {
                this.proposals.set(p.id, p);
            }
            const s = statSync(filePath);
            this.lastMtimeMs = s.mtimeMs;
        }
        catch {
            this.proposals.clear();
        }
    }
    async save() {
        const filePath = join(this.wikiRoot, META_DIR, PROPOSALS_FILE);
        const list = Array.from(this.proposals.values());
        try {
            await writeFile(filePath, JSON.stringify(list, null, 2), 'utf8');
            const s = statSync(filePath);
            this.lastMtimeMs = s.mtimeMs;
        }
        catch {
            // 安全容错
        }
    }
}
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
