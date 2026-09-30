import Dexie from 'dexie';
import type { Diagram } from '@/lib/domain/diagram';
import { request } from './storage-api';

const LOCAL_DB_NAME = 'ChartDB';
const IMPORTED_FLAG = 'chartdb-local-diagrams-imported';

const ENTITY_TABLES: Record<string, keyof Diagram> = {
    db_tables: 'tables',
    db_relationships: 'relationships',
    db_dependencies: 'dependencies',
    areas: 'areas',
    db_custom_types: 'customTypes',
    notes: 'notes',
};

const readFlag = (): boolean => {
    try {
        return localStorage.getItem(IMPORTED_FLAG) === 'true';
    } catch {
        return false;
    }
};

const writeFlag = () => {
    try {
        localStorage.setItem(IMPORTED_FLAG, 'true');
    } catch {
        // Import is idempotent, so a missing flag only costs a re-check.
    }
};

// One-time upload of diagrams created before server storage existed. The
// local IndexedDB copy is left untouched as a backup.
export const importLocalDiagrams = async (): Promise<void> => {
    if (readFlag() || !(await Dexie.exists(LOCAL_DB_NAME))) {
        return;
    }

    const localDb = new Dexie(LOCAL_DB_NAME);
    try {
        await localDb.open();
        const tableNames = new Set(localDb.tables.map((t) => t.name));
        if (!tableNames.has('diagrams')) {
            writeFlag();
            return;
        }

        const serverDiagrams = await request<Diagram[]>('GET', '/diagrams');
        const serverIds = new Set(serverDiagrams.map((d) => d.id));
        const localDiagrams: Diagram[] = await localDb
            .table('diagrams')
            .toArray();

        for (const diagram of localDiagrams) {
            if (serverIds.has(diagram.id)) continue;

            const full: Record<string, unknown> = { ...diagram };
            for (const [table, key] of Object.entries(ENTITY_TABLES)) {
                if (!tableNames.has(table)) continue;
                const rows = await localDb
                    .table(table)
                    .where('diagramId')
                    .equals(diagram.id)
                    .toArray();
                full[key] = rows.map(
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    ({ diagramId, ...entity }) => entity
                );
            }
            await request('POST', '/diagrams', full);
        }
        writeFlag();
    } finally {
        localDb.close();
    }
};
