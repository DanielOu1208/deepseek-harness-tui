import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
const DRAFT_OWNER = '@chalk/dsh-tui';
const DRAFT_VERSION = 1;
const DRAFT_FILE_PREFIX = 'dsh-tui-draft-v1-';
const DRAFT_FILE_SUFFIX = '.json';
/**
 * Return the private, path-safe filename used for one session's draft.
 *
 * A digest keeps arbitrary session IDs out of path syntax and bounds the
 * filename length. The payload stores the original ID as a collision guard.
 */
export function sessionDraftFileName(sessionId) {
    const id = validateSessionId(sessionId);
    const digest = createHash('sha256').update(id, 'utf8').digest('hex');
    return `${DRAFT_FILE_PREFIX}${digest}${DRAFT_FILE_SUFFIX}`;
}
/**
 * A small owner-private store for one text draft per session.
 *
 * The root is supplied by the caller so the store does not choose a global
 * location or mix its files with Harness session persistence.
 */
export class SessionDraftStore {
    pending = new Map();
    configuredRoot;
    constructor(rootDir) {
        if (typeof rootDir !== 'string' || rootDir.length === 0) {
            throw new TypeError('draft root directory must be a non-empty path');
        }
        this.configuredRoot = resolve(rootDir);
    }
    async load(sessionId) {
        const id = validateSessionId(sessionId);
        await this.flush(id);
        const root = await this.resolveRoot(false);
        if (root === undefined)
            return undefined;
        const path = this.pathForSession(root, id);
        let metadata;
        try {
            metadata = await lstat(path);
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
        // Never follow an object supplied at the store's filename. In particular,
        // a corrupt symlink must not turn a load into a read outside the root.
        if (!metadata.isFile() || metadata.isSymbolicLink())
            return undefined;
        let raw;
        try {
            raw = await readFile(path, 'utf8');
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
        return parseDraft(raw, id);
    }
    async save(sessionId, text) {
        const id = validateSessionId(sessionId);
        if (typeof text !== 'string')
            throw new TypeError('draft text must be a string');
        if (text.length === 0) {
            await this.delete(id);
            return;
        }
        await this.enqueue(id, async () => {
            const root = await this.resolveRoot(true);
            if (root === undefined)
                throw new Error('draft root is unavailable');
            await this.writeAtomically(this.pathForSession(root, id), {
                owner: DRAFT_OWNER,
                version: DRAFT_VERSION,
                sessionId: id,
                text,
            });
        });
    }
    async delete(sessionId) {
        const id = validateSessionId(sessionId);
        await this.enqueue(id, async () => {
            const root = await this.resolveRoot(false);
            if (root === undefined)
                return;
            const path = this.pathForSession(root, id);
            try {
                await unlink(path);
            }
            catch (error) {
                if (!isMissing(error))
                    throw error;
            }
        });
    }
    /** Wait for all queued mutations, or only one session's mutations. */
    async flush(sessionId) {
        if (sessionId !== undefined) {
            const id = validateSessionId(sessionId);
            while (true) {
                const pending = this.pending.get(id);
                if (pending === undefined)
                    return;
                await pending;
                if (this.pending.get(id) === undefined)
                    return;
            }
        }
        while (this.pending.size > 0) {
            await Promise.all([...this.pending.values()]);
        }
    }
    async enqueue(sessionId, operation) {
        const previous = this.pending.get(sessionId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        let tracked;
        tracked = next.finally(() => {
            if (this.pending.get(sessionId) === tracked)
                this.pending.delete(sessionId);
        });
        this.pending.set(sessionId, tracked);
        await tracked;
    }
    async resolveRoot(create) {
        if (create) {
            await mkdir(this.configuredRoot, { recursive: true, mode: 0o700 });
            await chmod(this.configuredRoot, 0o700);
        }
        let root;
        try {
            root = await realpath(this.configuredRoot);
        }
        catch (error) {
            if (!create && isMissing(error))
                return undefined;
            throw error;
        }
        const metadata = await lstat(root);
        if (!metadata.isDirectory()) {
            if (!create)
                return undefined;
            throw new Error(`draft root is not a directory: ${this.configuredRoot}`);
        }
        return root;
    }
    pathForSession(root, sessionId) {
        const path = resolve(root, sessionDraftFileName(sessionId));
        const escaped = relative(root, path);
        if (escaped === '..' || escaped.startsWith(`..${sep}`) || isAbsolute(escaped)) {
            throw new Error('draft path escaped its root');
        }
        return path;
    }
    async writeAtomically(path, draft) {
        const temporary = join(resolve(path, '..'), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
        const serialized = `${JSON.stringify(draft)}\n`;
        let handle;
        try {
            handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
            await handle.writeFile(serialized, 'utf8');
            await handle.sync();
            await handle.close();
            handle = undefined;
            await rename(temporary, path);
            await chmod(path, 0o600);
        }
        finally {
            if (handle !== undefined)
                await handle.close().catch(() => { });
            await unlink(temporary).catch(() => { });
        }
    }
}
export function createSessionDraftStore(rootDir) {
    return new SessionDraftStore(rootDir);
}
function parseDraft(raw, sessionId) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return undefined;
    }
    if (!isRecord(value))
        return undefined;
    if (value.owner !== DRAFT_OWNER || value.version !== DRAFT_VERSION)
        return undefined;
    if (value.sessionId !== sessionId || typeof value.text !== 'string' || value.text.length === 0) {
        return undefined;
    }
    return value.text;
}
function validateSessionId(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.includes('\0')) {
        throw new TypeError('session ID must be a non-empty string without NUL bytes');
    }
    return sessionId;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isMissing(error) {
    return isRecord(error) && error.code === 'ENOENT';
}
