import { basename, extname } from 'node:path';
import type { WikiDoc } from '../types.js';

export class WikiGraph {
  // 标准化标识 -> 出链集合 (以 relPath 为准)
  private forwardMap: Map<string, Set<string>> = new Map();
  // 标准化标识 -> 反向链接集合 (以 relPath 为准)
  private backMap: Map<string, Set<string>> = new Map();
  // 查找字典: title / alias / basename / relPath -> relPath
  private nameToRelPath: Map<string, string> = new Map();

  build(docs: WikiDoc[]): void {
    this.forwardMap.clear();
    this.backMap.clear();
    this.nameToRelPath.clear();

    // 1. 建立全局名称索引表
    for (const doc of docs) {
      const rel = doc.relPath;
      this.nameToRelPath.set(rel.toLowerCase(), rel);
      this.nameToRelPath.set(doc.title.toLowerCase(), rel);

      const baseNameWithoutExt = basename(rel, extname(rel));
      this.nameToRelPath.set(baseNameWithoutExt.toLowerCase(), rel);

      if (doc.frontmatter.aliases && Array.isArray(doc.frontmatter.aliases)) {
        for (const alias of doc.frontmatter.aliases) {
          if (typeof alias === 'string' && alias.trim()) {
            this.nameToRelPath.set(alias.trim().toLowerCase(), rel);
          }
        }
      }

      this.forwardMap.set(rel, new Set());
      this.backMap.set(rel, new Set());
    }

    // 2. 解析链接拓扑
    for (const doc of docs) {
      const sourceRel = doc.relPath;
      const outgoing = this.forwardMap.get(sourceRel)!;

      for (const link of doc.links) {
        const targetRel = this.resolveReference(link.target);
        if (targetRel) {
          outgoing.add(targetRel);
          const incoming = this.backMap.get(targetRel);
          if (incoming) {
            incoming.add(sourceRel);
          }
        }
      }
    }
  }

  resolveReference(ref: string): string | undefined {
    const clean = ref.trim().toLowerCase();
    return this.nameToRelPath.get(clean);
  }

  getForwardLinks(relPath: string): string[] {
    const set = this.forwardMap.get(relPath);
    return set ? Array.from(set) : [];
  }

  getBackLinks(relPath: string): string[] {
    const set = this.backMap.get(relPath);
    return set ? Array.from(set) : [];
  }

  exportAdjacency(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [key, set] of this.forwardMap.entries()) {
      result[key] = Array.from(set);
    }
    return result;
  }
}
