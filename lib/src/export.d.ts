import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
/** Version of the TUI-owned, portable session export envelope. */
export declare const SESSION_EXPORT_VERSION: 1;
/**
 * Disclosure shown in every export. Session content is user-controlled and may
 * contain sensitive workspace information even though attachment bytes are not
 * copied into the export.
 */
export declare const SESSION_EXPORT_DISCLOSURE = "Exports can contain prompts, tool output, and local paths.";
export type SessionExportFormat = 'json' | 'markdown';
export type SessionExportJsonValue = null | boolean | number | string | SessionExportJsonValue[] | {
    readonly [key: string]: SessionExportJsonValue;
};
/** Caller-owned inputs; persistence flushing and reading remain outside this module. */
export interface SessionExportInput {
    readonly header: SessionHeader;
    readonly events: readonly SessionEvent[];
    /** One projection object, or a named map/array of projection snapshots. */
    readonly projections?: unknown;
}
export interface SessionExportEnvelope {
    readonly format: 'deepseek-harness-session-export';
    readonly version: typeof SESSION_EXPORT_VERSION;
    readonly disclosure: typeof SESSION_EXPORT_DISCLOSURE;
    readonly session: {
        readonly header: SessionExportJsonValue;
        readonly events: readonly SessionExportJsonValue[];
        readonly projections: SessionExportJsonValue;
    };
}
export interface WriteSessionExportOptions {
    readonly format?: SessionExportFormat;
    /** Refuse an existing destination unless this is explicitly true. */
    readonly overwrite?: boolean;
    readonly signal?: AbortSignal;
}
export interface WrittenSessionExport {
    readonly path: string;
    readonly format: SessionExportFormat;
    readonly bytes: number;
}
/** Build a detached version-1 envelope without contacting persistence. */
export declare function createSessionExport(input: SessionExportInput, signal?: AbortSignal): SessionExportEnvelope;
/** Render the detached envelope as stable, human-readable JSON. */
export declare function renderSessionExportJson(input: SessionExportInput, signal?: AbortSignal): string;
/** Render a deterministic Markdown transcript plus a lossless event-log appendix. */
export declare function renderSessionExportMarkdown(input: SessionExportInput, signal?: AbortSignal): string;
/** Return a basename that cannot escape a caller-selected output directory. */
export declare function defaultSessionExportFilename(header: Pick<SessionHeader, 'id' | 'createdAt'>, format?: SessionExportFormat): string;
/**
 * Atomically write one export with mode 0600. A no-overwrite commit uses an
 * exclusive hard-link step, so a destination appearing after staging is still
 * never replaced. The temporary artifact is removed on every failed path.
 */
export declare function writeSessionExport(input: SessionExportInput, destination: string, options?: WriteSessionExportOptions): Promise<WrittenSessionExport>;
