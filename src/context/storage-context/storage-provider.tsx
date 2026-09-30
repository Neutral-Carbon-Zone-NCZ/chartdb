import React, { useEffect, useState } from 'react';
import type { StorageContext } from './storage-context';
import { storageContext } from './storage-context';
import type { Diagram } from '@/lib/domain/diagram';
import type { DBTable } from '@/lib/domain/db-table';
import type { DBRelationship } from '@/lib/domain/db-relationship';
import type { ChartDBConfig } from '@/lib/domain/config';
import type { DBDependency } from '@/lib/domain/db-dependency';
import type { Area } from '@/lib/domain/area';
import type { DBCustomType } from '@/lib/domain/db-custom-type';
import type { DiagramFilter } from '@/lib/domain/diagram-filter/diagram-filter';
import type { Note } from '@/lib/domain/note';
import { request, reviveConfig, reviveDiagram, toPatch } from './storage-api';
import { importLocalDiagrams } from './import-local-diagrams';

type IncludeOptions = Parameters<StorageContext['getDiagram']>[1];

const INCLUDE_KINDS: [keyof NonNullable<IncludeOptions>, string][] = [
    ['includeTables', 'tables'],
    ['includeRelationships', 'relationships'],
    ['includeDependencies', 'dependencies'],
    ['includeAreas', 'areas'],
    ['includeCustomTypes', 'custom-types'],
    ['includeNotes', 'notes'],
];

const includeQuery = (options: IncludeOptions = {}): string => {
    const kinds = INCLUDE_KINDS.filter(([option]) => options[option]).map(
        ([, kind]) => kind
    );
    return kinds.length ? `?include=${kinds.join(',')}` : '';
};

const byName = <T extends { name: string }>(items: T[]): T[] =>
    items.sort((a, b) => a.name.localeCompare(b.name));

const enc = encodeURIComponent;
const diagramPath = (diagramId: string) => `/diagrams/${enc(diagramId)}`;
const entityPath = (diagramId: string, kind: string, id?: string) =>
    `${diagramPath(diagramId)}/${kind}${id !== undefined ? `/${enc(id)}` : ''}`;

// CRUD for one entity collection (tables, relationships, ...).
const entityOps = <T,>(kind: string) => ({
    add: (diagramId: string, entity: T) =>
        request('POST', entityPath(diagramId, kind), entity),
    get: async (diagramId: string, id: string) =>
        (await request<T | null>('GET', entityPath(diagramId, kind, id))) ??
        undefined,
    update: (id: string, attributes: Partial<T>) =>
        request('PATCH', `/entities/${kind}/${enc(id)}`, toPatch(attributes)),
    remove: (diagramId: string, id: string) =>
        request('DELETE', entityPath(diagramId, kind, id)),
    list: (diagramId: string) =>
        request<T[]>('GET', entityPath(diagramId, kind)),
    removeAll: (diagramId: string) =>
        request('DELETE', entityPath(diagramId, kind)),
});

const tables = entityOps<DBTable>('tables');
const relationships = entityOps<DBRelationship>('relationships');
const dependencies = entityOps<DBDependency>('dependencies');
const areas = entityOps<Area>('areas');
const customTypes = entityOps<DBCustomType>('custom-types');
const notes = entityOps<Note>('notes');

const storage: StorageContext = {
    getConfig: async () =>
        reviveConfig(await request<ChartDBConfig>('GET', '/config')),
    updateConfig: (config) => request('PATCH', '/config', toPatch(config)),

    getDiagramFilter: async (diagramId) =>
        (await request<DiagramFilter | null>(
            'GET',
            `${diagramPath(diagramId)}/filter`
        )) ?? undefined,
    updateDiagramFilter: (diagramId, filter) =>
        request('PUT', `${diagramPath(diagramId)}/filter`, filter),
    deleteDiagramFilter: (diagramId) =>
        request('DELETE', `${diagramPath(diagramId)}/filter`),

    addDiagram: ({ diagram }) => request('POST', '/diagrams', diagram),
    listDiagrams: async (options) =>
        (
            await request<Diagram[]>('GET', `/diagrams${includeQuery(options)}`)
        ).map((diagram) => {
            const revived = reviveDiagram(diagram);
            if (revived.relationships) byName(revived.relationships);
            if (revived.customTypes) byName(revived.customTypes);
            return revived;
        }),
    getDiagram: async (id, options) => {
        const diagram = await request<Diagram | null>(
            'GET',
            `${diagramPath(id)}${includeQuery(options)}`
        );
        if (!diagram) return undefined;
        const revived = reviveDiagram(diagram);
        if (revived.relationships) byName(revived.relationships);
        if (revived.customTypes) byName(revived.customTypes);
        return revived;
    },
    updateDiagram: ({ id, attributes }) =>
        request('PATCH', diagramPath(id), toPatch(attributes)),
    deleteDiagram: (id) => request('DELETE', diagramPath(id)),

    addTable: ({ diagramId, table }) => tables.add(diagramId, table),
    getTable: ({ diagramId, id }) => tables.get(diagramId, id),
    updateTable: ({ id, attributes }) => tables.update(id, attributes),
    putTable: ({ diagramId, table }) =>
        request('PUT', entityPath(diagramId, 'tables', table.id), table),
    deleteTable: ({ diagramId, id }) => tables.remove(diagramId, id),
    listTables: (diagramId) => tables.list(diagramId),
    deleteDiagramTables: (diagramId) => tables.removeAll(diagramId),

    addRelationship: ({ diagramId, relationship }) =>
        relationships.add(diagramId, relationship),
    getRelationship: ({ diagramId, id }) => relationships.get(diagramId, id),
    updateRelationship: ({ id, attributes }) =>
        relationships.update(id, attributes),
    deleteRelationship: ({ diagramId, id }) =>
        relationships.remove(diagramId, id),
    listRelationships: async (diagramId) =>
        byName(await relationships.list(diagramId)),
    deleteDiagramRelationships: (diagramId) =>
        relationships.removeAll(diagramId),

    addDependency: ({ diagramId, dependency }) =>
        dependencies.add(diagramId, dependency),
    getDependency: ({ diagramId, id }) => dependencies.get(diagramId, id),
    updateDependency: ({ id, attributes }) =>
        dependencies.update(id, attributes),
    deleteDependency: ({ diagramId, id }) => dependencies.remove(diagramId, id),
    listDependencies: (diagramId) => dependencies.list(diagramId),
    deleteDiagramDependencies: (diagramId) => dependencies.removeAll(diagramId),

    addArea: ({ diagramId, area }) => areas.add(diagramId, area),
    getArea: ({ diagramId, id }) => areas.get(diagramId, id),
    updateArea: ({ id, attributes }) => areas.update(id, attributes),
    deleteArea: ({ diagramId, id }) => areas.remove(diagramId, id),
    listAreas: (diagramId) => areas.list(diagramId),
    deleteDiagramAreas: (diagramId) => areas.removeAll(diagramId),

    addCustomType: ({ diagramId, customType }) =>
        customTypes.add(diagramId, customType),
    getCustomType: ({ diagramId, id }) => customTypes.get(diagramId, id),
    updateCustomType: ({ id, attributes }) =>
        customTypes.update(id, attributes),
    deleteCustomType: ({ diagramId, id }) => customTypes.remove(diagramId, id),
    listCustomTypes: async (diagramId) =>
        byName(await customTypes.list(diagramId)),
    deleteDiagramCustomTypes: (diagramId) => customTypes.removeAll(diagramId),

    addNote: ({ diagramId, note }) => notes.add(diagramId, note),
    getNote: ({ diagramId, id }) => notes.get(diagramId, id),
    updateNote: ({ id, attributes }) => notes.update(id, attributes),
    deleteNote: ({ diagramId, id }) => notes.remove(diagramId, id),
    listNotes: (diagramId) => notes.list(diagramId),
    deleteDiagramNotes: (diagramId) => notes.removeAll(diagramId),
};

// Shared across providers so the local import runs once per page load.
let localImport: Promise<void> | undefined;

export const StorageProvider: React.FC<React.PropsWithChildren> = ({
    children,
}) => {
    const [ready, setReady] = useState(false);

    useEffect(() => {
        localImport ??= importLocalDiagrams().catch((error) => {
            console.error('Failed to import local diagrams', error);
        });
        localImport.then(() => setReady(true));
    }, []);

    if (!ready) {
        return null;
    }

    return (
        <storageContext.Provider value={storage}>
            {children}
        </storageContext.Provider>
    );
};
