import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

test.describe('Table API', () => {
    test.describe.configure({ mode: 'serial' });

    const session = loadSession();

    let tableId: string;
    let flowId: string;
    let createdWebhookId: string;
    const webhookUrl = process.env.WEBHOOK_URL || 'https://webhook.site/test-table-webhook';

    test.beforeAll(async ({ request }) => {
        // 1. Get or create a table ID dynamically if not supplied via env
        if (process.env.TABLE_ID) {
            tableId = process.env.TABLE_ID;
        } else {
            const tablesRes = await request.get('tables', {
                params: { projectId: session.projectId },
                headers: { Authorization: `Bearer ${session.token}` },
            });

            if (tablesRes.ok()) {
                const tablesBody = await tablesRes.json();
                if (Array.isArray(tablesBody.data) && tablesBody.data.length > 0) {
                    tableId = tablesBody.data[0].id;
                }
            }

            if (!tableId) {
                // Create a table if none exists
                const createTableRes = await request.post('tables', {
                    headers: { Authorization: `Bearer ${session.token}` },
                    data: {
                        name: 'API Test Table',
                        projectId: session.projectId,
                    },
                });
                if (createTableRes.ok()) {
                    const createdTable = await createTableRes.json();
                    tableId = createdTable.id;
                }
            }
        }

        // 2. Get or create a flow ID dynamically if not supplied via env
        if (process.env.FLOW_ID) {
            flowId = process.env.FLOW_ID;
        } else {
            const flowsRes = await request.get('flows', {
                params: { projectId: session.projectId },
                headers: { Authorization: `Bearer ${session.token}` },
            });

            if (flowsRes.ok()) {
                const flowsBody = await flowsRes.json();
                if (Array.isArray(flowsBody.data) && flowsBody.data.length > 0) {
                    flowId = flowsBody.data[0].id;
                }
            }
        }
    });

    test('List tables', async ({ request }) => {
        const response = await request.get('tables', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('data');
        expect(Array.isArray(body.data)).toBe(true);
        expect(body.data.length).toBeGreaterThan(0);
    });

    test('Get a table by id', async ({ request }) => {
        expect(tableId).toBeDefined();

        const response = await request.get(`tables/${tableId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.id).toBe(tableId);
        expect(body.projectId).toBe(session.projectId);
    });

    test('Update a table', async ({ request }) => {
        expect(tableId).toBeDefined();
        const updatedName = `API Table Updated ${Date.now()}`;

        const response = await request.post(`tables/${tableId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                name: updatedName,
            },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body.id).toBe(tableId);
        expect(body.name).toBe(updatedName);
    });

    test('Export a table', async ({ request }) => {
        expect(tableId).toBeDefined();

        const response = await request.post(`tables/${tableId}/export`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {},
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('fields');
        expect(body).toHaveProperty('rows');
    });

    test('Export selected records from a table', async ({ request }) => {
        expect(tableId).toBeDefined();

        const response = await request.post(`tables/${tableId}/export`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                recordIds: [],
            },
        });

        expect(response.status()).toBe(200);
        const body = await response.json();
        expect(body).toHaveProperty('fields');
        expect(body).toHaveProperty('rows');
    });

    test('Create a table webhook', async ({ request }) => {
        expect(tableId).toBeDefined();

        const payload: Record<string, unknown> = {
            events: [
                'RECORD_CREATED',
                'RECORD_UPDATED',
                'RECORD_DELETED',
            ],
            webhookUrl: webhookUrl,
        };

        if (flowId) {
            payload.flowId = flowId;
        }

        const response = await request.post(`tables/${tableId}/webhooks`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: payload,
        });

        expect([200, 201]).toContain(response.status());
        const body = await response.json();
        expect(body.tableId).toBe(tableId);
        createdWebhookId = body.id;
    });

    test('Delete a table webhook', async ({ request }) => {
        expect(tableId).toBeDefined();
        expect(createdWebhookId).toBeDefined();

        const response = await request.delete(`tables/${tableId}/webhooks/${createdWebhookId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {},
        });

        expect([200, 204]).toContain(response.status());
    });

    test('Delete a table', async ({ request }) => {
        // Create a temporary table specifically to test deletion
        const createTempResponse = await request.post('tables', {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {
                name: `Temp Table for Deletion ${Date.now()}`,
                projectId: session.projectId,
            },
        });

        expect([200, 201]).toContain(createTempResponse.status());
        const tempTable = await createTempResponse.json();
        const tempTableId = tempTable.id;

        // Delete the temporary table
        const deleteResponse = await request.delete(`tables/${tempTableId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
                'Content-Type': 'application/json',
            },
            data: {},
        });

        expect([200, 204]).toContain(deleteResponse.status());
    });
});