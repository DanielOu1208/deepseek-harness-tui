import { type CredentialInfo } from '@deepseek-ai/dsh-credentials';
import type { ReadStream, WriteStream } from 'node:tty';
export declare const DEEPSEEK_API_KEY_REF: import("@deepseek-ai/dsh-credentials").CredentialRef;
export interface CredentialService {
    describe(ref: typeof DEEPSEEK_API_KEY_REF): Promise<CredentialInfo>;
    set(ref: typeof DEEPSEEK_API_KEY_REF, value: string): Promise<void>;
    unset(ref: typeof DEEPSEEK_API_KEY_REF): Promise<void>;
}
export interface OpenCredentialServiceResult {
    credentials: CredentialService;
    close(): Promise<void>;
}
export declare function openOfficialCredentialService(): Promise<OpenCredentialServiceResult>;
export declare function readMaskedSecret(input?: ReadStream, output?: WriteStream): Promise<string>;
export declare function confirmCredentialLogout(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream): Promise<boolean>;
export declare function describeCredential(info: CredentialInfo): string;
