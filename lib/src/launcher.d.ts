import { type ProfileManifest } from '@deepseek-ai/dsh-app-boot';
import { type OpenCredentialServiceResult } from './auth.js';
export declare const HELP = "Usage: deepseek [options] [initial-prompt...]\n       deepseek auth [status|logout]\n\nRun the official DeepSeek Harness with the standalone terminal UI.\n\nOptions:\n  -r, --resume <id>        resume a persisted session\n  -C, --cwd <directory>    set the working directory for a new session\n  -p, --prompt <words...>  submit an initial prompt after startup\n  -h, --help               show this help without changing Harness state\n  -V, --version            output the launcher version without changing Harness state\n\nAll other arguments are forwarded unchanged to the official Harness tui profile.\n";
export interface LauncherDependencies {
    version: string;
    stdout(text: string): void;
    stderr(text: string): void;
    resolveProfileDir(): string;
    initProfile(path: string, bundles: string[]): void;
    healProfileModules(): void;
    readProfileManifest(path: string): ProfileManifest;
    writeProfileManifest(path: string, manifest: ProfileManifest): void;
    openCredentials(): Promise<OpenCredentialServiceResult>;
    readSecret(): Promise<string>;
    confirmLogout(): Promise<boolean>;
    runDsh(args: string[]): Promise<number>;
}
export declare function ensureTuiProfile(deps: LauncherDependencies): void;
export declare function runLauncher(argv: string[], deps: LauncherDependencies): Promise<number>;
export declare function runOfficialDsh(args: string[]): Promise<number>;
export declare function productionDependencies(): LauncherDependencies;
