import type { Context } from '@deepseek-ai/cordis';
import { Config } from './core/config.js';
import type { WikiConfig } from './types.js';
export declare const name = "dsh-plugin-wiki";
export declare const inject: string[];
export { Config };
export declare function apply(ctx: Context, config: WikiConfig): Promise<void>;
