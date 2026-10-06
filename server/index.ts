// ChartDB persistence API.
//
// Stores diagrams in PostgreSQL. Runs behind nginx, which checks every request
// against /api/auth/verify here and forwards the login name in
// X-Forwarded-User. The server binds to localhost only, so nginx is the sole
// entry point.
import crypto from 'node:crypto';
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
// Local development without nginx only. Ignored in production.
const devUser = isProduction ? undefined : process.env.DEV_USER;

const appUsername = (process.env.APP_USERNAME ?? 'ncz').toLowerCase();
const appPassword = process.env.APP_PASSWORD;

if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
}

if (isProduction && !appPassword) {
    console.error('APP_PASSWORD is required');
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
    user_id  text PRIMARY KEY,
    data     jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS diagram_filters (
    user_id     text NOT NULL,
    diagram_id  text NOT NULL,
    data        jsonb NOT NULL,
    PRIMARY KEY (user_id, diagram_id)
);

-- Early deployments keyed these tables by Google email.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'user_configs' AND column_name = 'email') THEN
        ALTER TABLE user_configs RENAME COLUMN email TO user_id;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'diagram_filters' AND column_name = 'email') THEN
        ALTER TABLE diagram_filters RENAME COLUMN email TO user_id;
    END IF;
END $$;
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

const authenticate = (req: http.IncomingMessage): string => {
    const header = req.headers['x-forwarded-user'];
    const forwarded = Array.isArray(header) ? header[0] : header;
    // nginx normally resolves the user for us, but check the session directly
    // too so the API never depends on the proxy alone.
    const user = forwarded || currentUser(req) || devUser;
    if (!user) {
        throw new HttpError(401, 'Not authenticated');
    }
    return user.toLowerCase();
};

// ---------- Session cookies ----------
//
// Signing key derives from the shared password, so sessions survive restarts
// and deploys but every session dies the moment the password changes. That
// keeps the login persistent without another secret to manage.
const SESSION_COOKIE = 'chartdb_session';
const SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const sessionKey = crypto
    .createHash('sha256')
    .update(`${appUsername}:${appPassword ?? ''}`)
    .digest();

const signPayload = (payload: string) =>
    crypto.createHmac('sha256', sessionKey).update(payload).digest('base64url');

// Comparison that does not leak the secret's length or contents by timing.
const secretsMatch = (a: string, b: string) => {
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    // Hash first so timingSafeEqual always sees equal-length buffers.
    return crypto.timingSafeEqual(
        crypto.createHash('sha256').update(left).digest(),
        crypto.createHash('sha256').update(right).digest()
    );
};

const issueSession = (user: string): string => {
    const payload = Buffer.from(
        JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS })
    ).toString('base64url');
    return `${payload}.${signPayload(payload)}`;
};

const readSession = (token: string | undefined): string | undefined => {
    if (!token || !appPassword) {
        return undefined;
    }
    const separator = token.lastIndexOf('.');
    if (separator <= 0) {
        return undefined;
    }
    const payload = token.slice(0, separator);
    if (!secretsMatch(token.slice(separator + 1), signPayload(payload))) {
        return undefined;
    }
    try {
        const { u, exp } = JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf8')
        ) as { u?: unknown; exp?: unknown };
        if (typeof u !== 'string' || typeof exp !== 'number') {
            return undefined;
        }
        return exp > Date.now() ? u.toLowerCase() : undefined;
    } catch {
        return undefined;
    }
};

const readCookie = (req: http.IncomingMessage, name: string) =>
    (req.headers.cookie ?? '')
        .split(';')
        .map((part) => part.trim())
        .find((part) => part.startsWith(`${name}=`))
        ?.slice(name.length + 1);

// Browsers that still have the old HTTP basic credentials stay signed in.
const readBasicAuth = (req: http.IncomingMessage): string | undefined => {
    const header = req.headers.authorization;
    if (!appPassword || !header?.startsWith('Basic ')) {
        return undefined;
    }
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) {
        return undefined;
    }
    const username = decoded.slice(0, separator).toLowerCase();
    const password = decoded.slice(separator + 1);
    return secretsMatch(username, appUsername) &&
        secretsMatch(password, appPassword)
        ? username
        : undefined;
};

const currentUser = (req: http.IncomingMessage): string | undefined =>
    readSession(readCookie(req, SESSION_COOKIE)) ?? readBasicAuth(req);

const isSecureRequest = (req: http.IncomingMessage) => {
    const header = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(header) ? header[0] : header;
    return (proto ?? '').split(',')[0].trim() === 'https';
};

const sessionCookie = (req: http.IncomingMessage, token: string | null) =>
    [
        `${SESSION_COOKIE}=${token ?? ''}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        token ? `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : 'Max-Age=0',
        ...(isSecureRequest(req) ? ['Secure'] : []),
    ].join('; ');

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
    user: string;
    params: string[];
    url: URL;
    body: () => Promise<unknown>;
    req: http.IncomingMessage;
    res: http.ServerResponse;
}) => Promise<unknown>;

interface Route {
    method: string;
    pattern: RegExp;
    handler: Handler;
    // Reachable without an authenticated user (the sign-in endpoints).
    open?: boolean;
}

const routes: Route[] = [];
const route = (
    method: string,
    path: string,
    handler: Handler,
    options: { open?: boolean } = {}
) => {
    const pattern = new RegExp(`^${path.replace(/:[a-z]+/gi, '([^/]+)')}/?$`);
    routes.push({ method, pattern, handler, ...options });
};

// ---------- Sign in / sign out ----------

// nginx asks this for every request (auth_request) and passes the answer on as
// X-Forwarded-User.
route(
    'GET',
    '/api/auth/verify',
    async ({ req, res }) => {
        const user = currentUser(req) ?? devUser;
        if (!user) {
            throw new HttpError(401, 'Not authenticated');
        }
        res.writeHead(204, { 'X-Auth-User': user.toLowerCase() }).end();
    },
    { open: true }
);

route(
    'POST',
    '/api/auth/login',
    async ({ body, req, res }) => {
        const { password } = requireObject(await body(), 'body');
        const valid =
            !!appPassword &&
            typeof password === 'string' &&
            secretsMatch(password, appPassword);

        if (!valid) {
            // Slow down password guessing without keeping any state.
            await new Promise((resolve) => setTimeout(resolve, 500));
            throw new HttpError(401, 'Incorrect password');
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Set-Cookie': sessionCookie(req, issueSession(appUsername)),
        }).end(JSON.stringify({ user: appUsername }));
    },
    { open: true }
);

route(
    'POST',
    '/api/auth/logout',
    async ({ req, res }) => {
        res.writeHead(204, {
            'Set-Cookie': sessionCookie(req, null),
        }).end();
    },
    { open: true }
);

route('GET', '/api/me', async ({ user }) => ({ user }));

// Config (per user)
route('GET', '/api/config', async ({ user }) => {
    const existing = await pool.query<{ data: Json }>(
        'SELECT data FROM user_configs WHERE user_id = $1',
        [user]
    );
    if (existing.rows[0]) {
        return existing.rows[0].data;
    }
    const first = await pool.query<{ id: string }>(
        'SELECT id FROM diagrams ORDER BY created_at LIMIT 1'
    );
    const config = { defaultDiagramId: first.rows[0]?.id ?? '' };
    const { rows } = await pool.query<{ data: Json }>(
        `INSERT INTO user_configs (user_id, data) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
         RETURNING data`,
        [user, config]
    );
    return rows[0].data;
});

route('PATCH', '/api/config', async ({ user, body }) => {
    const { set, unset } = parsePatch(await body());
    await pool.query(
        `INSERT INTO user_configs (user_id, data) VALUES ($1, $2::jsonb - $3::text[])
         ON CONFLICT (user_id)
         DO UPDATE SET data = (user_configs.data || $2::jsonb) - $3::text[]`,
        [user, set, unset]
    );
});

// Diagram filters (per user)
route('GET', '/api/diagrams/:id/filter', async ({ user, params: [id] }) => {
    const { rows } = await pool.query<{ data: Json }>(
        'SELECT data FROM diagram_filters WHERE user_id = $1 AND diagram_id = $2',
        [user, id]
    );
    return rows[0]?.data ?? null;
});

route(
    'PUT',
    '/api/diagrams/:id/filter',
    async ({ user, params: [id], body }) => {
        const filter = requireObject(await body(), 'filter');
        await pool.query(
            `INSERT INTO diagram_filters (user_id, diagram_id, data) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, diagram_id) DO UPDATE SET data = EXCLUDED.data`,
            [user, id, { ...filter, diagramId: id }]
        );
    }
);

route('DELETE', '/api/diagrams/:id/filter', async ({ user, params: [id] }) => {
    await pool.query(
        'DELETE FROM diagram_filters WHERE user_id = $1 AND diagram_id = $2',
        [user, id]
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

route('POST', '/api/diagrams', async ({ user, body }) => {
    const diagram = requireObject(await body(), 'diagram');
    const id = requireId(diagram, 'diagram');
    await withTransaction(async (client) => {
        await client.query(
            `INSERT INTO diagrams (id, data, created_by, updated_by)
             VALUES ($1, $2, $3, $3)`,
            [id, stripCollections(diagram), user]
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

route('PATCH', '/api/diagrams/:id', async ({ user, params: [id], body }) => {
    const { set, unset } = parsePatch(await body());
    const newId = typeof set.id === 'string' && set.id ? set.id : id;
    await withTransaction(async (client) => {
        await client.query(
            `UPDATE diagrams
             SET id = $2, data = (data || $3::jsonb) - $4::text[],
                 updated_by = $5, updated_at = now()
             WHERE id = $1`,
            [id, newId, stripCollections(set), unset, user]
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
        const path = decodeURI(url.pathname);
        for (const { method, pattern, handler, open } of routes) {
            const match = method === req.method ? pattern.exec(path) : null;
            if (!match) continue;
            const params = match.slice(1).map(decodeURIComponent);
            const result = await handler({
                user: open ? '' : authenticate(req),
                params,
                url,
                body: () => readJson(req),
                req,
                res,
            });
            // Handlers that need custom headers answer the request themselves.
            if (!res.headersSent) {
                send(res, 200, result);
            }
            return;
        }
        throw new HttpError(404, 'Not found');
    } catch (error) {
        if (res.headersSent) {
            console.error(`${req.method} ${url.pathname} failed late`, error);
            res.end();
        } else if (error instanceof HttpError) {
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
