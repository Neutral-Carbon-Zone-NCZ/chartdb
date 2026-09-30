import type { Diagram } from '@/lib/domain/diagram';
import type { ChartDBConfig } from '@/lib/domain/config';

export class StorageApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

// Every request runs in call order so writes land in the order the app issued
// them and reads observe earlier writes, matching the old IndexedDB semantics.
let queue: Promise<unknown> = Promise.resolve();

const send = async <T>(
    method: string,
    path: string,
    body?: unknown
): Promise<T> => {
    const response = await fetch(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: {
            Accept: 'application/json',
            ...(body !== undefined && { 'Content-Type': 'application/json' }),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
        // Credentials rejected (e.g. password changed): reload to re-prompt.
        window.location.reload();
    }

    if (!response.ok) {
        const message = await response
            .json()
            .then((data: { error?: string }) => data.error)
            .catch(() => undefined);
        throw new StorageApiError(
            response.status,
            message ?? `${method} ${path} failed with ${response.status}`
        );
    }

    if (response.status === 204) {
        return undefined as T;
    }
    return (await response.json()) as T;
};

export const request = <T = void>(
    method: string,
    path: string,
    body?: unknown
): Promise<T> => {
    const result = queue.then(() => send<T>(method, path, body));
    queue = result.catch(() => undefined);
    return result;
};

// Undefined attributes remove the key (as Dexie's update does); JSON would
// otherwise drop them silently.
export const toPatch = (attributes: object) => {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined) {
            unset.push(key);
        } else {
            set[key] = value;
        }
    }
    return { set, unset };
};

export const reviveDiagram = (diagram: Diagram): Diagram => ({
    ...diagram,
    createdAt: new Date(diagram.createdAt),
    updatedAt: new Date(diagram.updatedAt),
});

export const reviveConfig = (config: ChartDBConfig): ChartDBConfig => ({
    ...config,
    ...(config.exportActions && {
        exportActions: config.exportActions.map((date) => new Date(date)),
    }),
});
