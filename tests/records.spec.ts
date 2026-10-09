import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Records API', () => {
    test.describe.configure({ mode: 'serial' });

    const session = loadSession();
    let tableId: string;
    let recordId: string;

    test('Create a new table for records', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('tables', {
            data: {
                name: 'API Test Records Table',
                projectId: session.projectId,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Create table response:', body);

        expect.soft(body.id).toBeTruthy();
        expect.soft(typeof body.id).toBe('string');
        expect.soft(body.projectId).toBe(session.projectId);

        tableId = body.id;
    });

    test('Create records', async ({ request }) => {
        expect.soft(tableId).toBeTruthy();

        const responseStartTime = Date.now();
        const response = await request.post('records', {
            data: {
                tableId: tableId,
                records: [
                    []
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);

        const body = await response.json();
        console.log('Create records response:', body);

        if (Array.isArray(body) && body.length > 0) {
            recordId = body[0].id;
        } else if (body && body.data && Array.isArray(body.data) && body.data.length > 0) {
            recordId = body.data[0].id;
        } else if (body && body.id) {
            recordId = body.id;
        }

        if (recordId) {
            expect.soft(recordId).toBeTruthy();
            expect.soft(typeof recordId).toBe('string');
        }
    });

    test('List records', async ({ request }) => {
        expect.soft(tableId).toBeTruthy();

        const responseStartTime = Date.now();
        const response = await request.get('records', {
            params: { tableId: tableId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('List records response:', body);
        expect.soft(body).toHaveProperty('data');
        expect.soft(Array.isArray(body.data)).toBe(true);
    });

    test('Get a record by id', async ({ request }) => {
        if (!recordId) {
            test.skip(!recordId, 'No recordId available');
            return;
        }

        const responseStartTime = Date.now();
        const response = await request.get(`records/${recordId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Get record response:', body);
        expect.soft(body.id).toBe(recordId);
    });

    test('Update a record', async ({ request }) => {
        if (!recordId) {
            test.skip(!recordId, 'No recordId available');
            return;
        }

        const responseStartTime = Date.now();
        const response = await request.post(`records/${recordId}`, {
            data: {
                tableId: tableId,
                values: {},
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        const body = await response.json().catch(() => null);
        console.log('Update record response:', body);

        expect.soft(response.status()).toBe(200);
        if (body && body.id) {
            expect.soft(body.id).toBe(recordId);
        }
    });

    test('Delete a record', async ({ request }) => {
        if (!recordId) {
            test.skip(!recordId, 'No recordId available');
            return;
        }

        const responseStartTime = Date.now();
        const response = await request.delete(`records/${recordId}`, {
            data: {
                tableId: tableId,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft([200, 204, 404]).toContain(response.status());
    });

    test('Delete test table', async ({ request }) => {
        expect.soft(tableId).toBeTruthy();

        const responseStartTime = Date.now();
        const response = await request.delete(`tables/${tableId}`, {
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
