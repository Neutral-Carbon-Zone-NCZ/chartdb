// ChartDB persistence API.
//
// Stores diagrams in PostgreSQL. Runs behind oauth2-proxy, which authenticates
// users with Google and forwards the verified address in X-Forwarded-Email.
// The server binds to localhost only, so the proxy is the sole entry point.
import http from 'node:http';
import pg from 'pg';

const ENTITY_KINDS = [
    'tables',
    'relationships',
    'dependencies',
    'areas',
    'custom-types',
    'notes',
] as const;
type EntityKind = (typeof ENTITY_KINDS)[number];

// Diagram fields that hold entity collections (stored in diagram_entities).
const DIAGRAM_COLLECTION_KEYS: Record<EntityKind, string> = {
    tables: 'tables',
    relationships: 'relationships',
    dependencies: 'dependencies',
    areas: 'areas',
    'custom-types': 'customTypes',
    notes: 'notes',
};

const MAX_BODY_BYTES = 50 * 1024 * 1024;

const isProduction = process.env.NODE_ENV === 'production';
const databaseUrl = process.env.DATABASE_URL;
const port = Number(process.env.API_PORT ?? 3000);
const host = process.env.API_HOST ?? '127.0.0.1';
const allowedDomains = (process.env.ALLOWED_EMAIL_DOMAINS ?? 'nczgroup.com')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
// Local development without oauth2-proxy only. Ignored in production.
const devUserEmail = isProduction ? undefined : process.env.DEV_USER_EMAIL;

if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS diagrams (
    id          text PRIMARY KEY,
    data        jsonb NOT NULL,
    created_by  text NOT NULL,
    updated_by  text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS diagram_entities (
    kind        text NOT NULL,
    id          text NOT NULL,
    diagram_id  text NOT NULL,
    data        jsonb NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS diagram_entities_diagram_idx
    ON diagram_entities (diagram_id, kind);

CREATE TABLE IF NOT EXISTS user_configs (
    email  text PRIMARY KEY,
    data   jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS diagram_filters (
    email       text NOT NULL,
    diagram_id  text NOT NULL,
    data        jsonb NOT NULL,
    PRIMARY KEY (email, diagram_id)
);
`;

class HttpError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

type Json = Record<string, unknown>;

interface Patch {
    set: Json;
    unset: string[];
}

const isObject = (value: unknown): value is Json =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const requireObject = (value: unknown, name: string): Json => {
    if (!isObject(value)) {
        throw new HttpError(400, `${name} must be an object`);
    }
    return value;
};

const requireId = (value: Json, name: string): string => {
    if (typeof value.id !== 'string' || value.id.length === 0) {
        throw new HttpError(400, `${name}.id must be a non-empty string`);
    }
    return value.id;
};

const parsePatch = (body: unknown): Patch => {
    const obj = requireObject(body, 'body');
    const set = requireObject(obj.set ?? {}, 'set');
    const unset = obj.unset ?? [];
    if (
        !Array.isArray(unset) ||
        !unset.every((key) => typeof key === 'string')
    ) {
        throw new HttpError(400, 'unset must be an array of strings');
    }
    return { set, unset };
};

const parseKind = (value: string): EntityKind => {
    if (!(ENTITY_KINDS as readonly string[]).includes(value)) {
        throw new HttpError(404, `Unknown entity kind: ${value}`);
    }
    return value as EntityKind;
};

const parseIncludes = (url: URL): EntityKind[] =>
    (url.searchParams.get('include') ?? '')
        .split(',')
        .filter(Boolean)
        .map(parseKind);

const stripCollections = (diagram: Json): Json => {
    const meta = { ...diagram };
    for (const key of Object.values(DIAGRAM_COLLECTION_KEYS)) {
        delete meta[key];
    }
    return meta;
};

const emailDomainAllowed = (email: string): boolean => {
    const domain = email.split('@').pop()?.toLowerCase() ?? '';
    return allowedDomains.some(
        (allowed) => domain === allowed || domain.endsWith(`.${allowed}`)
    );
};

const authenticate = (req: http.IncomingMessage): string => {
    const header = req.headers['x-forwarded-email'];
    const email = (Array.isArray(header) ? header[0] : header) ?? devUserEmail;
    if (!email) {
        throw new HttpError(401, 'Not authenticated');
    }
    if (!emailDomainAllowed(email)) {
        throw new HttpError(403, 'Email domain not allowed');
    }
    return email.toLowerCase();
};

const readJson = async (req: http.IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        size += (chunk as Buffer).length;
        if (size > MAX_BODY_BYTES) {
            throw new HttpError(413, 'Request body too large');
        }
        chunks.push(chunk as Buffer);
    }
    if (size === 0) {
        return undefined;
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'Invalid JSON body');
    }
};

const withTransaction = async <T>(
    fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
};

// ---------- Data access ----------

const attachEntities = async (
    diagrams: Json[],
    kinds: EntityKind[]
): Promise<Json[]> => {
    if (diagrams.length === 0 || kinds.length === 0) {
        return diagrams;
    }
    const byId = new Map<string, Json>();
    for (const diagram of diagrams) {
        for (const kind of kinds) {
            diagram[DIAGRAM_COLLECTION_KEYS[kind]] = [];
        }
        byId.set(diagram.id as string, diagram);
    }
    const { rows } = await pool.query<{
        kind: EntityKind;
        diagram_id: string;
        data: Json;
    }>(
        `SELECT kind, diagram_id, data FROM diagram_entities
         WHERE diagram_id = ANY($1::text[]) AND kind = ANY($2::text[])`,
        [[...byId.keys()], kinds]
    );
    for (const row of rows) {
        const diagram = byId.get(row.diagram_id);
        (diagram?.[DIAGRAM_COLLECTION_KEYS[row.kind]] as Json[]).push(row.data);
    }
    return diagrams;
};

const insertEntity = (
    client: pg.Pool | pg.PoolClient,
    kind: EntityKind,
    diagramId: string,
    entity: Json
) =>
    client.query(
        `INSERT INTO diagram_entities (kind, id, diagram_id, data)
         VALUES ($1, $2, $3, $4)`,
        [kind, requireId(entity, 'entity'), diagramId, entity]
    );

// ---------- Routing ----------

type Handler = (ctx: {
    email: string;
    params: string[];
    url: URL;
    body: () => Promise<unknown>;
}) => Promise<unknown>;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
const route = (method: string, path: string, handler: Handler) => {
    const pattern = new RegExp(`^${path.replace(/:[a-z]+/gi, '([^/]+)')}/?$`);
    routes.push({ method, pattern, handler });
};

route('GET', '/api/me', async ({ email }) => ({ email }));

// Config (per user)
route('GET', '/api/config', async ({ email }) => {
    const existing = await pool.query<{ data: Json }>(
        'SELECT data FROM user_configs WHERE email = $1',
        [email]
    );
    if (existing.rows[0]) {
        return existing.rows[0].data;
    }
    const first = await pool.query<{ id: string }>(
        'SELECT id FROM diagrams ORDER BY created_at LIMIT 1'
    );
    const config = { defaultDiagramId: first.rows[0]?.id ?? '' };
    const { rows } = await pool.query<{ data: Json }>(
        `INSERT INTO user_configs (email, data) VALUES ($1, $2)
         ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
         RETURNING data`,
        [email, config]
    );
    return rows[0].data;
});

route('PATCH', '/api/config', async ({ email, body }) => {
    const { set, unset } = parsePatch(await body());
    await pool.query(
        `INSERT INTO user_configs (email, data) VALUES ($1, $2::jsonb - $3::text[])
         ON CONFLICT (email)
         DO UPDATE SET data = (user_configs.data || $2::jsonb) - $3::text[]`,
        [email, set, unset]
    );
});

// Diagram filters (per user)
route('GET', '/api/diagrams/:id/filter', async ({ email, params: [id] }) => {
    const { rows } = await pool.query<{ data: Json }>(
        'SELECT data FROM diagram_filters WHERE email = $1 AND diagram_id = $2',
        [email, id]
    );
    return rows[0]?.data ?? null;
});

route(
    'PUT',
    '/api/diagrams/:id/filter',
    async ({ email, params: [id], body }) => {
        const filter = requireObject(await body(), 'filter');
        await pool.query(
            `INSERT INTO diagram_filters (email, diagram_id, data) VALUES ($1, $2, $3)
         ON CONFLICT (email, diagram_id) DO UPDATE SET data = EXCLUDED.data`,
            [email, id, { ...filter, diagramId: id }]
        );
    }
);

route('DELETE', '/api/diagrams/:id/filter', async ({ email, params: [id] }) => {
    await pool.query(
        'DELETE FROM diagram_filters WHERE email = $1 AND diagram_id = $2',
        [email, id]
    );
});

// Diagrams (shared across the organisation)
route('GET', '/api/diagrams', async ({ url }) => {
    const { rows } = await pool.query<{ data: Json }>(
        'SELECT data FROM diagrams ORDER BY created_at'
    );
    return attachEntities(
        rows.map((r) => r.data),
        parseIncludes(url)
    );
});

route('POST', '/api/diagrams', async ({ email, body }) => {
    const diagram = requireObject(await body(), 'diagram');
    const id = requireId(diagram, 'diagram');
    await withTransaction(async (client) => {
        await client.query(
            `INSERT INTO diagrams (id, data, created_by, updated_by)
             VALUES ($1, $2, $3, $3)`,
            [id, stripCollections(diagram), email]
        );
        for (const kind of ENTITY_KINDS) {
            const entities = diagram[DIAGRAM_COLLECTION_KEYS[kind]] ?? [];
            if (!Array.isArray(entities)) {
                throw new HttpError(400, `${kind} must be an array`);
            }
            for (const entity of entities) {
                await insertEntity(
                    client,
                    kind,
                    id,
                    requireObject(entity, kind)
                );
            }
        }
    });
});

route('GET', '/api/diagrams/:id', async ({ params: [id], url }) => {
    const { rows } = await pool.query<{ data: Json }>(
        'SELECT data FROM diagrams WHERE id = $1',
        [id]
    );
    if (!rows[0]) {
        return null;
    }
    const [diagram] = await attachEntities([rows[0].data], parseIncludes(url));
    return diagram;
});

route('PATCH', '/api/diagrams/:id', async ({ email, params: [id], body }) => {
    const { set, unset } = parsePatch(await body());
    const newId = typeof set.id === 'string' && set.id ? set.id : id;
    await withTransaction(async (client) => {
        await client.query(
            `UPDATE diagrams
             SET id = $2, data = (data || $3::jsonb) - $4::text[],
                 updated_by = $5, updated_at = now()
             WHERE id = $1`,
            [id, newId, stripCollections(set), unset, email]
        );
        if (newId !== id) {
            await client.query(
                'UPDATE diagram_entities SET diagram_id = $2 WHERE diagram_id = $1',
                [id, newId]
            );
            await client.query(
                'UPDATE diagram_filters SET diagram_id = $2 WHERE diagram_id = $1',
                [id, newId]
            );
        }
    });
});

route('DELETE', '/api/diagrams/:id', async ({ params: [id] }) => {
    await withTransaction(async (client) => {
        await client.query('DELETE FROM diagrams WHERE id = $1', [id]);
        await client.query(
            'DELETE FROM diagram_entities WHERE diagram_id = $1',
            [id]
        );
        await client.query(
            'DELETE FROM diagram_filters WHERE diagram_id = $1',
            [id]
        );
    });
});

// Entities within a diagram
route('GET', '/api/diagrams/:id/:kind', async ({ params: [id, kind] }) => {
    const { rows } = await pool.query<{ data: Json }>(
        'SELECT data FROM diagram_entities WHERE diagram_id = $1 AND kind = $2',
        [id, parseKind(kind)]
    );
    return rows.map((r) => r.data);
});

route(
    'POST',
    '/api/diagrams/:id/:kind',
    async ({ params: [id, kind], body }) => {
        await insertEntity(
            pool,
            parseKind(kind),
            id,
            requireObject(await body(), 'entity')
        );
    }
);

route('DELETE', '/api/diagrams/:id/:kind', async ({ params: [id, kind] }) => {
    await pool.query(
        'DELETE FROM diagram_entities WHERE diagram_id = $1 AND kind = $2',
        [id, parseKind(kind)]
    );
});

route(
    'GET',
    '/api/diagrams/:id/:kind/:eid',
    async ({ params: [id, kind, eid] }) => {
        const { rows } = await pool.query<{ data: Json }>(
            `SELECT data FROM diagram_entities
         WHERE diagram_id = $1 AND kind = $2 AND id = $3`,
            [id, parseKind(kind), eid]
        );
        return rows[0]?.data ?? null;
    }
);

route(
    'PUT',
    '/api/diagrams/:id/:kind/:eid',
    async ({ params: [id, kind, eid], body }) => {
        const entity = requireObject(await body(), 'entity');
        if (requireId(entity, 'entity') !== eid) {
            throw new HttpError(400, 'entity.id does not match URL');
        }
        await pool.query(
            `INSERT INTO diagram_entities (kind, id, diagram_id, data)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (kind, id)
         DO UPDATE SET diagram_id = EXCLUDED.diagram_id, data = EXCLUDED.data`,
            [parseKind(kind), eid, id, entity]
        );
    }
);

route(
    'DELETE',
    '/api/diagrams/:id/:kind/:eid',
    async ({ params: [id, kind, eid] }) => {
        await pool.query(
            'DELETE FROM diagram_entities WHERE diagram_id = $1 AND kind = $2 AND id = $3',
            [id, parseKind(kind), eid]
        );
    }
);

// Entity update by id only (mirrors the storage interface)
route(
    'PATCH',
    '/api/entities/:kind/:eid',
    async ({ params: [kind, eid], body }) => {
        const { set, unset } = parsePatch(await body());
        const newId = typeof set.id === 'string' && set.id ? set.id : eid;
        await pool.query(
            `UPDATE diagram_entities
         SET id = $3, data = (data || $4::jsonb) - $5::text[]
         WHERE kind = $1 AND id = $2`,
            [parseKind(kind), eid, newId, set, unset]
        );
    }
);

// ---------- Server ----------

const send = (res: http.ServerResponse, status: number, payload?: unknown) => {
    if (payload === undefined) {
        res.writeHead(status === 200 ? 204 : status).end();
        return;
    }
    const json = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
    }).end(json);
};

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
        const email = authenticate(req);
        const path = decodeURI(url.pathname);
        for (const { method, pattern, handler } of routes) {
            const match = method === req.method ? pattern.exec(path) : null;
            if (!match) continue;
            const params = match.slice(1).map(decodeURIComponent);
            const result = await handler({
                email,
                params,
                url,
                body: () => readJson(req),
            });
            send(res, 200, result);
            return;
        }
        throw new HttpError(404, 'Not found');
    } catch (error) {
        if (error instanceof HttpError) {
            send(res, error.status, { error: error.message });
        } else if ((error as { code?: string }).code === '23505') {
            send(res, 409, { error: 'Already exists' });
        } else {
            console.error(`${req.method} ${url.pathname} failed`, error);
            send(res, 500, { error: 'Internal server error' });
        }
    }
});

await pool.query(SCHEMA);
server.listen(port, host, () => {
    console.log(`chartdb api listening on http://${host}:${port}`);
});

const shutdown = () => {
    server.close(() => void pool.end().then(() => process.exit(0)));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
