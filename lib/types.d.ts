/**
 * dsh-plugin-wiki core types
 */
export type DocType = 'project' | 'decision' | 'preference' | 'person' | 'asset' | 'general';
export type DocStatus = 'active' | 'developing' | 'completed' | 'archived' | 'planned';
export interface WikiFrontmatter {
    title?: string;
    type?: DocType | string;
    status?: DocStatus | string;
    tags?: string[];
    aliases?: string[];
    updated?: string;
    [key: string]: unknown;
}
export interface WikiLink {
    raw: string;
    target: string;
    alias?: string;
}
export interface WikiDoc {
    /** Relative path to wiki root, normalized with forward slashes (e.g. "Project/DSH.md") */
    relPath: string;
    /** Absolute path on host filesystem */
    absPath: string;
    mtimeMs: number;
    sizeBytes: number;
    frontmatter: WikiFrontmatter;
    title: string;
    type: string;
    status: string;
    links: WikiLink[];
    headings: string[];
    summary: string;
    rawContent: string;
}
export interface SearchMatch {
    relPath: string;
    title: string;
    type: string;
    status: string;
    excerpt: string;
    score: number;
    forwardLinks: string[];
    backLinks: string[];
}
export type ProposalType = 'create' | 'append_section' | 'update_frontmatter' | 'record_decision';
export type ProposalStatus = 'pending' | 'applied' | 'rejected';
export interface Proposal {
    id: string;
    createdAt: number;
    type: ProposalType;
    targetRelPath: string;
    title: string;
    section?: string;
    content: string;
    reason: string;
    confidence: number;
    status: ProposalStatus;
    appliedAt?: number;
    rejectedAt?: number;
}
export interface CacheEntry {
    mtimeMs: number;
    sizeBytes: number;
    doc: WikiDoc;
}
export interface DiskCache {
    version: number;
    entries: Record<string, CacheEntry>;
}
export interface WikiConfig {
    /** Wiki directory path. Defaults to ~/.dsh/wiki when empty */
    path: string;
    maxContextTokens: number;
    autoWatch: boolean;
}
