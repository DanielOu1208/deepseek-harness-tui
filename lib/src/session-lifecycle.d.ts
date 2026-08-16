import type { ModelSelection } from '@deepseek-ai/dsh-agent';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
export declare function modelSelectionFromEvents(events: readonly SessionEvent[], fallback: ModelSelection): ModelSelection;
export declare function forkSeedEvents(events: readonly SessionEvent[], boundary: number): SessionEvent[];
