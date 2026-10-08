import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import type { Proposal, ProposalType } from '../types.js';
import { inferDocTypeFromPath, replaceSection } from './parser.js';

const PROPOSALS_FILE = 'proposals.json';
const BACKUP_DIR = 'backups';
const META_DIR = '.wiki';

export class ProposalStore {
  private proposals: Map<string, Proposal> = new Map();

  constructor(private readonly wikiRoot: string) {}

  async init(): Promise<void> {
    await this.ensureDirs();
    await this.load();
  }

  async createProposal(params: {
    type: ProposalType;
    targetRelPath: string;
    title: string;
    section?: string;
    content: string;
    reason: string;
    confidence: number;
    replaceSection?: boolean;
  }): Promise<Proposal> {
    const id = this.generateShortId();
    const proposal: Proposal = {
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
      ...(params.replaceSection !== undefined ? { replaceSection: params.replaceSection } : {}),
    };

    this.proposals.set(id, proposal);
    await this.save();
    return proposal;
  }

  getProposal(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }

  listPending(): Proposal[] {
    return Array.from(this.proposals.values())
      .filter((p) => p.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  listAll(): Proposal[] {
    return Array.from(this.proposals.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * 备份目标文件至 .wiki/backups
   */
  async backupFile(absTarget: string, targetRelPath: string): Promise<string | null> {
    if (!existsSync(absTarget)) return null;
    await this.ensureDirs();
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = targetRelPath.replace(/[\/\\]/g, '__');
    const backupPath = resolve(this.wikiRoot, META_DIR, BACKUP_DIR, `${ts}_${safeName}`);
    await copyFile(absTarget, backupPath);
    return backupPath;
  }

  /**
   * 直接写入文件（直写模式：支持自动备份、小节就地替换/追加、新建自动补齐 Frontmatter）
   */
  async writeDirect(params: {
    targetRelPath: string;
    content: string;
    section?: string;
    title?: string;
    reason?: string;
  }): Promise<{ ok: boolean; applied: boolean; message: string; targetPath: string; warning?: string; sizeBytes?: number }> {
    const normalizedRoot = resolve(this.wikiRoot);
    const cleanRel = params.targetRelPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const absTarget = resolve(normalizedRoot, cleanRel);

    // 路径防穿透检查
    if (!absTarget.startsWith(normalizedRoot)) {
      return { ok: false, applied: false, message: '安全阻断：目标路径超出 Wiki 根目录', targetPath: cleanRel };
    }

    await mkdir(dirname(absTarget), { recursive: true });

    if (existsSync(absTarget)) {
      // 目标文件已存在：先备份
      await this.backupFile(absTarget, cleanRel);
      const existing = await readFile(absTarget, 'utf8');
      let updated: string;

      if (params.section && params.section.trim()) {
        const replaceRes = replaceSection(existing, params.section, params.content);
        if (replaceRes.replaced) {
          // 传了 section 且该节存在 -> 就地替换该节正文
          updated = replaceRes.content;
        } else {
          // 传了 section 但找不到 -> 在文末新增该节
          const cleanSec = params.section.replace(/^#+\s*/, '').trim();
          updated = `${existing.trimEnd()}\n\n## ${cleanSec}\n\n${params.content.trim()}\n`;
        }
      } else {
        // 未传 section -> 追加到文末
        updated = `${existing.trimEnd()}\n\n${params.content.trim()}\n`;
      }

      await writeFile(absTarget, updated, 'utf8');
    } else {
      // 目标文件不存在：创建并补齐 frontmatter
      const effectiveTitle = params.title && params.title.trim() ? params.title.trim() : basename(cleanRel, extname(cleanRel));
      const type = inferDocTypeFromPath(cleanRel);
      const today = new Date().toISOString().slice(0, 10);

      const frontmatter = [
        '---',
        `title: "${effectiveTitle.replace(/"/g, '\\"')}"`,
        `type: "${type}"`,
        'status: "active"',
        `updated: "${today}"`,
        '---',
        '',
      ].join('\n');

      let body = '';
      if (params.section && params.section.trim()) {
        const cleanSec = params.section.replace(/^#+\s*/, '').trim();
        body = `# ${effectiveTitle}\n\n## ${cleanSec}\n\n${params.content.trim()}\n`;
      } else {
        body = `# ${effectiveTitle}\n\n${params.content.trim()}\n`;
      }

      await writeFile(absTarget, `${frontmatter}\n${body}`, 'utf8');
    }

    const s = await stat(absTarget);
    let message = `已成功写入 \`${cleanRel}\``;
    let warning: string | undefined;
    if (s.size > 4500) {
      const kb = (s.size / 1024).toFixed(1);
      warning = `文件大小已达 ${kb}KB（超出 4.5KB 软上限，约 2000 汉字）。建议提炼核心结论，避免无序堆叠，过细历史请移入 Archive/`;
      message += `。⚠️ 提示: ${warning}`;
    }

    const ret: { ok: boolean; applied: boolean; message: string; targetPath: string; warning?: string; sizeBytes?: number } = {
      ok: true,
      applied: true,
      message,
      targetPath: cleanRel,
      sizeBytes: s.size,
    };
    if (warning) {
      ret.warning = warning;
    }

    return ret;
  }

  /**
   * 批准并应用提案（执行安全合并与历史自动备份）
   */
  async approve(id: string): Promise<{ ok: boolean; message: string; targetPath: string }> {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      return { ok: false, message: `提案 ${id} 不存在`, targetPath: '' };
    }
    if (proposal.status !== 'pending') {
      return { ok: false, message: `提案 ${id} 已经是 ${proposal.status} 状态，不能重复审批`, targetPath: proposal.targetRelPath };
    }

    const normalizedRoot = resolve(this.wikiRoot);
    const absTarget = resolve(normalizedRoot, proposal.targetRelPath);

    // 路径防穿透检查
    if (!absTarget.startsWith(normalizedRoot)) {
      return { ok: false, message: '安全阻断：目标路径超出 Wiki 根目录', targetPath: proposal.targetRelPath };
    }

    await mkdir(dirname(absTarget), { recursive: true });

    // 1. 如果文件已存在，先做备份
    if (existsSync(absTarget)) {
      await this.backupFile(absTarget, proposal.targetRelPath);
    }

    // 2. 执行合并写入
    if (!existsSync(absTarget)) {
      // 全新文件创建
      const frontmatter = [
        '---',
        `title: "${proposal.title.replace(/"/g, '\\"')}"`,
        `type: "${proposal.type === 'record_decision' ? 'decision' : 'general'}"`,
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
    } else {
      // 既有文件追加或合并
      const existing = await readFile(absTarget, 'utf8');
      let updated: string;
      if (proposal.replaceSection && proposal.section) {
        const replaceRes = replaceSection(existing, proposal.section, proposal.content);
        if (replaceRes.replaced) {
          updated = replaceRes.content;
        } else {
          const cleanSec = proposal.section.replace(/^#+\s*/, '').trim();
          updated = `${existing.trimEnd()}\n\n## ${cleanSec}\n\n${proposal.content.trim()}\n`;
        }
      } else {
        updated = this.mergeSection(existing, proposal.section, proposal.content);
      }
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
  async reject(id: string): Promise<{ ok: boolean; message: string }> {
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

  private mergeSection(original: string, sectionTitle?: string, contentToAppend = ''): string {
    const trimmedAppend = contentToAppend.trim();
    if (!sectionTitle || !sectionTitle.trim()) {
      return `${original.trimEnd()}\n\n${trimmedAppend}\n`;
    }

    const headingRegex = new RegExp(`(^#{2,4}\\s+${escapeRegex(sectionTitle.trim())}\\s*$)`, 'm');
    const match = headingRegex.exec(original);

    if (!match) {
      // 不存在该节，直接在文末增加
      return `${original.trimEnd()}\n\n## ${sectionTitle.trim()}\n\n${trimmedAppend}\n`;
    }

    // 存在对应节，找到该节结束位置（下一个同级或更高层级标题，或者文章末尾）
    const matchIndex = match.index + match[0].length;
    const rest = original.slice(matchIndex);
    const nextHeadingMatch = /^#{2,3}\s+/m.exec(rest);

    if (!nextHeadingMatch) {
      return `${original.trimEnd()}\n\n${trimmedAppend}\n`;
    }

    const insertIndex = matchIndex + nextHeadingMatch.index;
    const before = original.slice(0, insertIndex).trimEnd();
    const after = original.slice(insertIndex).trimStart();

    return `${before}\n\n${trimmedAppend}\n\n${after}`;
  }

  private generateShortId(): string {
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
    let rand = '';
    for (let i = 0; i < 4; i++) {
      rand += chars[Math.floor(Math.random() * chars.length)];
    }
    return `prop-${rand}`;
  }

  private async ensureDirs(): Promise<void> {
    const meta = join(this.wikiRoot, META_DIR);
    const backup = join(meta, BACKUP_DIR);
    if (!existsSync(backup)) {
      await mkdir(backup, { recursive: true });
    }
  }

  private async load(): Promise<void> {
    const filePath = join(this.wikiRoot, META_DIR, PROPOSALS_FILE);
    if (!existsSync(filePath)) return;
    try {
      const data = await readFile(filePath, 'utf8');
      const list = JSON.parse(data) as Proposal[];
      this.proposals.clear();
      for (const p of list) {
        this.proposals.set(p.id, p);
      }
    } catch {
      this.proposals.clear();
    }
  }

  private async save(): Promise<void> {
    const filePath = join(this.wikiRoot, META_DIR, PROPOSALS_FILE);
    const list = Array.from(this.proposals.values());
    try {
      await writeFile(filePath, JSON.stringify(list, null, 2), 'utf8');
    } catch {
      // 安全容错
    }
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
