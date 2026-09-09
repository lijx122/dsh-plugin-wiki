import type { Proposal, ProposalType } from '../types.js';
export declare class ProposalStore {
    private readonly wikiRoot;
    private proposals;
    private lastMtimeMs;
    constructor(wikiRoot: string);
    ensureDiskSynced(): void;
    init(): Promise<void>;
    createProposal(params: {
        type: ProposalType;
        targetRelPath: string;
        title: string;
        section?: string;
        content: string;
        reason: string;
        confidence: number;
        entityType?: string;
    }): Promise<Proposal>;
    getProposal(id: string): Proposal | undefined;
    listPending(): Proposal[];
    listAll(): Proposal[];
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
