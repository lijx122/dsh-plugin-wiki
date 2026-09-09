import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import Schema from '@deepseek-ai/schemastery';
import type { WikiConfig } from '../types.js';

export const Config: Schema<WikiConfig> = Schema.object({
  path: Schema.string()
    .default('')
    .description('Wiki 根目录路径。留空时默认使用当前用户目录下的 ~/.dsh/wiki'),
  maxContextTokens: Schema.number()
    .default(1500)
    .description('注入 System Prompt 的上下文最大估算 token 限制'),
  autoWatch: Schema.boolean()
    .default(true)
    .description('是否启用文件系统变动监听，自动增量更新内存索引'),
});

/**
 * 严格解析并规范化 Wiki 根路径
 * 优先遵循用户要求：不强加绝对路径，默认回退至用户目录 ~/.dsh/wiki
 */
export function resolveWikiPath(rawPath?: string): string {
  const home = homedir();
  const defaultWikiPath = join(home, '.dsh', 'wiki');

  if (!rawPath || rawPath.trim() === '') {
    return defaultWikiPath;
  }

  const trimmed = rawPath.trim();

  // 处理 ~ 缩写
  if (trimmed === '~') {
    return defaultWikiPath;
  }
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return join(home, trimmed.slice(2));
  }

  // 若已经是绝对路径
  if (isAbsolute(trimmed)) {
    return resolve(trimmed);
  }

  // 相对路径解析（优先相对于 ~/.dsh，若以 . 或 .. 开头则相对于 process.cwd）
  if (trimmed.startsWith('.')) {
    return resolve(process.cwd(), trimmed);
  }

  return resolve(join(home, '.dsh'), trimmed);
}
