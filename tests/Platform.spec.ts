import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

test.describe('Platform and Flows', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();

    //  Retrieve platform information after login and validate user platform configuration.
    test('Get Platform Details', async ({ request }) => {
        const response = await request.get(`platforms/${session.platformId}`, {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(body.id).toBe(session.platformId);
        expect.soft(typeof body.name).toBe('string');
        expect.soft(body.name).toBeTruthy();
        expect.soft(body.ownerId).toBe(session.userId);
        expect.soft(body.plan).toBeTruthy();
        expect.soft(typeof body.usage).not.toBe('undefined');
    });

    //  Retrieve existing number of flows in the project/platform.
    test('Get Flow Count', async ({ request }) => {
        const response = await request.get('flows/count', {
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(typeof body).toBe('number');
        expect.soft(body).toBeGreaterThanOrEqual(0);
    });

    // Retrieve all flows available under a project to view existing flow configurations.
    test('Get Flows', async ({ request }) => {
        const response = await request.get('flows', {
            params: {
                projectId: session.projectId,
                cursor: '',
                limit: 10,
            },
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(Array.isArray(body.data)).toBe(true);


            const flow = body.data[0];
            expect.soft(typeof flow.id).toBe('string');
            expect.soft(flow.projectId).toBe(session.projectId);
            expect.soft(flow.version).toBeTruthy();
            expect.soft(typeof flow.version.id).toBe('string');
            expect.soft(flow.version.flowId).toBe(flow.id);
            expect.soft(typeof flow.status).toBe('string');
    });
});
