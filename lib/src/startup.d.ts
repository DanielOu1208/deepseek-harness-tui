import type { Context } from '@deepseek-ai/cordis';
import { Command } from 'commander';
export declare const name = "dsh-tui-startup";
export declare const inject: string[];
export declare const DSH_TUI_STARTUP_SERVICE = "dshTuiStartup";
export interface TuiStartupOptions {
    resume?: string;
    cwd?: string;
    prompt?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        dshTuiStartup: TuiStartupOptions;
    }
}
export declare function createTuiCommand(onParsed: (options: TuiStartupOptions) => void): Command;
export declare function apply(ctx: Context): void;
