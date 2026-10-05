import type { Proposal, ProposalType } from '../types.js';
export declare class ProposalStore {
    private readonly wikiRoot;
    private proposals;
    constructor(wikiRoot: string);
    init(): Promise<void>;
    createProposal(params: {
        type: ProposalType;
        targetRelPath: string;
        title: string;
        section?: string;
        content: string;
        reason: string;
        confidence: number;
        replaceSection?: boolean;
    }): Promise<Proposal>;
    getProposal(id: string): Proposal | undefined;
    listPending(): Proposal[];
    listAll(): Proposal[];
    /**
     * 备份目标文件至 .wiki/backups
     */
    backupFile(absTarget: string, targetRelPath: string): Promise<string | null>;
    /**
     * 直接写入文件（直写模式：支持自动备份、小节就地替换/追加、新建自动补齐 Frontmatter）
     */
    writeDirect(params: {
        targetRelPath: string;
        content: string;
        section?: string;
        title?: string;
        reason?: string;
    }): Promise<{
        ok: boolean;
        applied: boolean;
        message: string;
        targetPath: string;
    }>;
    /**
     * 批准并应用提案（执行安全合并与历史自动备份）
     */
    approve(id: string): Promise<{
        ok: boolean;
        message: string;
        targetPath: string;
    }>;
    /**
     * 拒绝提案
     */
    reject(id: string): Promise<{
        ok: boolean;
        message: string;
    }>;
    private mergeSection;
    private generateShortId;
    private ensureDirs;
    private load;
    private save;
}
