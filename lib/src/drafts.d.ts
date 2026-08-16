export interface SessionDraftStoreLike {
    load(sessionId: string): Promise<string | undefined>;
    save(sessionId: string, text: string): Promise<void>;
    delete(sessionId: string): Promise<void>;
    flush(sessionId?: string): Promise<void>;
}
/**
 * Return the private, path-safe filename used for one session's draft.
 *
 * A digest keeps arbitrary session IDs out of path syntax and bounds the
 * filename length. The payload stores the original ID as a collision guard.
 */
export declare function sessionDraftFileName(sessionId: string): string;
/**
 * A small owner-private store for one text draft per session.
 *
 * The root is supplied by the caller so the store does not choose a global
 * location or mix its files with Harness session persistence.
 */
export declare class SessionDraftStore implements SessionDraftStoreLike {
    private readonly pending;
    private readonly configuredRoot;
    constructor(rootDir: string);
    load(sessionId: string): Promise<string | undefined>;
    save(sessionId: string, text: string): Promise<void>;
    delete(sessionId: string): Promise<void>;
    /** Wait for all queued mutations, or only one session's mutations. */
    flush(sessionId?: string): Promise<void>;
    private enqueue;
    private resolveRoot;
    private pathForSession;
    private writeAtomically;
}
export declare function createSessionDraftStore(rootDir: string): SessionDraftStore;
