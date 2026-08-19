import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

test.describe('Table API', () => {
    test.describe.configure({ mode: 'serial' });

    const session = loadSession();
    let tableId: string;

    test('Create Table', async ({ request }) => {
        const tableName = 'New Table';

        const startTime = Date.now();
        const response = await request.post('tables', {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                name: tableName,
                projectId: session.projectId,
            },
        });
        const responseTime = Date.now() - startTime;

        console.log(`Create Table - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(200);
        expect.soft(responseTime).toBeLessThan(1000);

        const body = await response.json();

        expect.soft(body.id).toBeTruthy();
        expect.soft(typeof body.id).toBe('string');

        expect.soft(body.externalId).toBeTruthy();
        expect.soft(typeof body.externalId).toBe('string');

        expect.soft(body.name).toBe(tableName);

        expect.soft(body.projectId).toBe(session.projectId);

        expect.soft(body.agentId).toBeNull();
        expect.soft(body.trigger).toBeNull();
        expect.soft(body.status).toBeNull();

        // Verify created and updated are valid ISO-8601 timestamps
        expect.soft(new Date(body.created).getTime()).not.toBeNaN();
        expect.soft(new Date(body.updated).getTime()).not.toBeNaN();

        tableId = body.id;
    });

    test('List tables', async ({ request }) => {
        const startTime = Date.now();
        const response = await request.get('tables', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseTime = Date.now() - startTime;

        console.log(`List Tables - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(200);
        expect.soft(responseTime).toBeLessThan(1000);

        const body = await response.json();
        expect.soft(body).toHaveProperty('data');
        expect.soft(Array.isArray(body.data)).toBe(true);
        expect.soft(body.data.length).toBeGreaterThan(0);

        if (Array.isArray(body.data) && body.data.length > 0) {
            const item = body.data[0];
            expect.soft(item.id).toBeTruthy();
            expect.soft(item.name).toBeTruthy();
            expect.soft(item.projectId).toBe(session.projectId);
        }
    });

    test('Get a table by id', async ({ request }) => {
        expect.soft(tableId).toBeDefined();

        const startTime = Date.now();
        const response = await request.get(`tables/${tableId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseTime = Date.now() - startTime;

        console.log(`Get Table by ID - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(200);
        expect.soft(responseTime).toBeLessThan(1000);

        const body = await response.json();
        expect.soft(body.id).toBe(tableId);
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(body.name).toBeTruthy();
        expect.soft(body.externalId).toBeTruthy();
        expect.soft(new Date(body.created).getTime()).not.toBeNaN();
        expect.soft(new Date(body.updated).getTime()).not.toBeNaN();
    });

    test('Update a table', async ({ request }) => {
        expect.soft(tableId).toBeDefined();
        const updatedName = `API Table Updated ${Date.now()}`;

        const startTime = Date.now();
        const response = await request.post(`tables/${tableId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                name: updatedName,
            },
        });
        const responseTime = Date.now() - startTime;

        console.log(`Update Table - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(200);
        expect.soft(responseTime).toBeLessThan(1000);

        const body = await response.json();
        expect.soft(body.id).toBe(tableId);
        expect.soft(body.name).toBe(updatedName);
        expect.soft(body.projectId).toBe(session.projectId);
    });

    test('Export a table', async ({ request }) => {
        expect.soft(tableId).toBeDefined();

        const startTime = Date.now();
        const response = await request.post(`tables/${tableId}/export`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {},
        });
        const responseTime = Date.now() - startTime;

        console.log(`Export Table - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(200);
        expect.soft(responseTime).toBeLessThan(1000);

        const body = await response.json();
        expect.soft(body).toHaveProperty('fields');
        expect.soft(body).toHaveProperty('rows');
        expect.soft(Array.isArray(body.fields)).toBe(true);
        expect.soft(Array.isArray(body.rows)).toBe(true);
        expect.soft(body.name).toBeTruthy();
    });

    test('Export selected records from a table', async ({ request }) => {
        expect.soft(tableId).toBeDefined();

        const startTime = Date.now();
        const response = await request.post(`tables/${tableId}/export`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                recordIds: [],
            },
        });
        const responseTime = Date.now() - startTime;

        console.log(`Export Selected Records - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(200);
        expect.soft(responseTime).toBeLessThan(1000);

        const body = await response.json();
        expect.soft(body).toHaveProperty('fields');
        expect.soft(body).toHaveProperty('rows');
        expect.soft(Array.isArray(body.fields)).toBe(true);
        expect.soft(Array.isArray(body.rows)).toBe(true);
    });

    test('Delete a table', async ({ request }) => {
        expect.soft(tableId).toBeDefined();

        const startTime = Date.now();
        const response = await request.delete(`tables/${tableId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {},
        });
        const responseTime = Date.now() - startTime;

        console.log(`Delete Table - Status: ${response.status()}, Response Time: ${responseTime}ms`);

        expect.soft(response.status()).toBe(204);
        expect.soft(responseTime).toBeLessThan(1000);
    });
});