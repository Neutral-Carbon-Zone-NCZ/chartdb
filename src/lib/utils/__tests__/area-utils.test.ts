import { describe, expect, it } from 'vitest';
import {
    getAreaRectToFitTables,
    getPositionOutsideArea,
    isTableInsideArea,
} from '../area-utils';
import { getTableDimensions, type DBTable } from '../../domain/db-table';
import type { Area } from '../../domain/area';

const createTable = (overrides: Partial<DBTable>): DBTable => ({
    id: 'table-1',
    name: 'table',
    schema: 'public',
    x: 0,
    y: 0,
    fields: [],
    indexes: [],
    color: '#8eb7ff',
    isView: false,
    createdAt: 0,
    width: 224,
    ...overrides,
});

const area: Area = {
    id: 'area-1',
    name: 'Area',
    x: 0,
    y: 0,
    width: 1000,
    height: 800,
    color: '#b067e9',
};

describe('getAreaRectToFitTables', () => {
    it('returns null when the tables already fit', () => {
        const table = createTable({ x: 100, y: 100 });
        expect(getAreaRectToFitTables(area, [table])).toBeNull();
    });

    it('returns null for an empty area', () => {
        expect(getAreaRectToFitTables(area, [])).toBeNull();
    });

    it('grows right and down when a table moves past the edge', () => {
        const table = createTable({ x: 900, y: 750 });
        const { height } = getTableDimensions(table);
        const rect = getAreaRectToFitTables(area, [table]);

        expect(rect).toEqual({
            x: 0,
            y: 0,
            width: 900 + 224 + 30,
            height: 750 + height + 30,
        });
        expect(isTableInsideArea(table, { ...area, ...rect! })).toBe(true);
    });

    it('grows left and up, keeping the far edges in place', () => {
        const table = createTable({ x: -200, y: -100 });
        const rect = getAreaRectToFitTables(area, [table]);

        expect(rect).toEqual({
            x: -230,
            y: -150,
            width: 1000 + 230,
            height: 800 + 150,
        });
    });

    it('never shrinks an area larger than its tables', () => {
        const big: Area = { ...area, width: 5000, height: 5000 };
        const table = createTable({ x: 100, y: 100 });
        expect(getAreaRectToFitTables(big, [table])).toBeNull();
    });

    it('fits every child table at once', () => {
        const rect = getAreaRectToFitTables(area, [
            createTable({ id: 'a', x: -100, y: 100 }),
            createTable({ id: 'b', x: 1200, y: 100 }),
        ]);

        expect(rect?.x).toBe(-130);
        expect(rect!.x + rect!.width).toBe(1200 + 224 + 30);
    });
});

describe('getPositionOutsideArea', () => {
    it('places a table fully outside the area', () => {
        const table = createTable({ x: 100, y: 100 });
        const moved = { ...table, ...getPositionOutsideArea(area, table) };
        expect(isTableInsideArea(moved, area)).toBe(false);
        expect(moved.x).toBeGreaterThan(area.x + area.width);
    });
});
