import Schema from '@deepseek-ai/schemastery';
import type { WikiConfig } from '../types.js';
export declare const Config: Schema<WikiConfig>;
/**
 * 严格解析并规范化 Wiki 根路径
 * 优先遵循用户要求：不强加绝对路径，默认回退至用户目录 ~/.dsh/wiki
 */
export declare function resolveWikiPath(rawPath?: string): string;
