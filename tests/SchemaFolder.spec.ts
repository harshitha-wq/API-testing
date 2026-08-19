import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Schema Folders', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();


    let folderId: string;
    test('Create a new document schema folder', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('document/schema-folders', {
            data: {
                displayName: "API Test Schema Folder",
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
        expect.soft(body.displayName).toBe('API Test Schema Folder');
        expect.soft(body.projectId).toBe(session.projectId);

        folderId = body.id;

    });
    test('List document schema folders', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('document/schema-folders', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        console.log(body.data);
        const folder = body.data.find((f: { id: string }) => f.id === folderId);
        expect.soft(folder).toBeTruthy();
        expect.soft(folder?.displayName).toBe('API Test Schema Folder');
        expect.soft(folder?.projectId).toBe(session.projectId);
    });

    test('Rename a document schema folder', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.patch(
            `document/schema-folders/${folderId}`,
            {
                data: {
                    displayName: 'Updated API Test Schema Folder',
                },
                headers: {
                    Authorization: `Bearer ${session.token}`,
                },
            },
        );
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect(response.status()).toBe(200);

        const body = await response.json();

        expect(body.displayName).toBe('Updated API Test Schema Folder');
        expect(body.projectId).toBe(session.projectId);
        expect(body.id).toBe(folderId);
    });


    test('Get a document schema folder by id', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`document/schema-folders/${folderId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(folderId);
        expect.soft(body.displayName).toBe('Updated API Test Schema Folder');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');

    });

    test('Count schemas not assigned to any folder', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`document/schema-folders/uncategorized-count`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        // Not necessarily 0 - the project may already have other uncategorized schemas
        // (e.g. global seeded ones) independent of this test's own folder.
        expect.soft(typeof body.count).toBe('number');
        expect.soft(body.count).toBeGreaterThanOrEqual(0);
    });

    test('Delete a document schema folder', async ({ request }) => {
        console.log('Deleting folderId:', folderId);
        const responseStartTime = Date.now();
        const response = await request.delete(`document/schema-folders/${folderId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}`, },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        console.log('Delete status:', response.status());
        console.log('Delete body:', await response.text());
        expect(response.status()).toBe(200);
    });


});
