import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('app-connections', () => {
    test.describe.configure({ mode: 'serial' });

    let connectionId: string;

    // Creates (or updates, if the externalId already exists) a connection to a third-party
    // app/piece, storing the auth secret so flows/tools for that piece can use it.
    test('Upsert an app connection', async ({ request }) => {
        const session = loadSession();
        const externalId = `test-connection-${Date.now()}`;

        const responseStartTime = Date.now();
        const response = await request.post('app-connections', {
            data: {
                externalId,
                displayName: 'Test Connection',
                pieceName: '@docxster/piece-claude',
                projectId: session.projectId,
                metadata: {},
                type: 'SECRET_TEXT',
                value: { type: 'SECRET_TEXT', secret_text: 'fake-api-key-value' },
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);
        const body = await response.json();
        expect.soft(body.externalId).toBe(externalId);
        expect.soft(body.displayName).toBe('Test Connection');
        expect.soft(body.pieceName).toBe('@docxster/piece-claude');
        expect.soft(body.type).toBe('SECRET_TEXT');
        expect.soft(body.status).toBe('ACTIVE');
        expect.soft(Array.isArray(body.projectIds)).toBe(true);
        expect.soft(body.projectIds).toContain(session.projectId);

        connectionId = body.id;
    });

    // Updates an app connection's display name/metadata (not the secret value itself).
    test('Update an app connection', async ({ request }) => {
        const session = loadSession();

        const responseStartTime = Date.now();
        const response = await request.post(`app-connections/${connectionId}`, {
            data: {
                displayName: 'Updated Test Connection',
                metadata: { note: 'updated by test' },
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(connectionId);
        expect.soft(body.displayName).toBe('Updated Test Connection');
        expect.soft(body.metadata).toEqual({ note: 'updated by test' });
    });

    // Lists the people in a project who own at least one app connection.
    test('List app connection owners', async ({ request }) => {
        const session = loadSession();

        const responseStartTime = Date.now();
        const response = await request.get('app-connections/owners', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(Array.isArray(body.data)).toBe(true);
        expect.soft(body.data.length).toBeGreaterThan(0);
        for (const owner of body.data) {
            expect.soft(typeof owner.firstName).toBe('string');
            expect.soft(typeof owner.lastName).toBe('string');
            expect.soft(typeof owner.email).toBe('string');
        }
    });

    // Lists app connections for a project, so you can see what's already connected.
    test('List app connections', async ({ request }) => {
        const session = loadSession();

        const responseStartTime = Date.now();
        const response = await request.get('app-connections', {
            params: { projectId: session.projectId, pieceName: '@docxster/piece-claude' },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(Array.isArray(body.data)).toBe(true);

        const connection = body.data.find((c: { id: string }) => c.id === connectionId);
        expect.soft(connection?.displayName).toBe('Updated Test Connection');
        expect.soft(connection?.pieceName).toBe('@docxster/piece-claude');
        expect.soft(connection?.status).toBe('ACTIVE');
        expect.soft(Array.isArray(connection?.projectIds)).toBe(true);
    });

    // Points everything using one connection (e.g. flows) at a different connection instead,
    // then deletes the source connection. Uses its own throwaway pair, independent of connectionId.
    test('Replace app connections', async ({ request }) => {
        const session = loadSession();

        const createConnection = async (label: string) => {
            const res = await request.post('app-connections', {
                data: {
                    externalId: `replace-${label}-${Date.now()}`,
                    displayName: `Replace ${label}`,
                    pieceName: '@docxster/piece-claude',
                    projectId: session.projectId,
                    metadata: {},
                    type: 'SECRET_TEXT',
                    value: { type: 'SECRET_TEXT', secret_text: 'fake-api-key-value' },
                },
                headers: { Authorization: `Bearer ${session.token}` },
            });
            return (await res.json()).id as string;
        };

        const sourceId = await createConnection('source');
        const targetId = await createConnection('target');

        const responseStartTime = Date.now();
        const response = await request.post('app-connections/replace', {
            data: {
                sourceAppConnectionId: sourceId,
                targetAppConnectionId: targetId,
                projectId: session.projectId,
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(204);

        const listResponseStartTime = Date.now();
        const listResponse = await request.get('app-connections', {
            params: { projectId: session.projectId, pieceName: '@docxster/piece-claude' },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const listResponseDurationMs = Date.now() - listResponseStartTime;
        expect.soft(listResponseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        const listBody = await listResponse.json();
        // The source connection is deleted as part of the replace; the target survives.
        expect.soft(listBody.data.some((c: { id: string }) => c.id === sourceId)).toBe(false);
        expect.soft(listBody.data.some((c: { id: string }) => c.id === targetId)).toBe(true);

        await request.delete(`app-connections/${targetId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}` },
        });
    });

    // Permanently deletes the app connection (cleanup so this doesn't pile up in the project).
    test('Delete the app connection', async ({ request }) => {
        const session = loadSession();

        const responseStartTime = Date.now();
        const response = await request.delete(`app-connections/${connectionId}`, {
            data: {},
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(204);
    });
});
