import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Folders', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();
    // shared folder id across tests

    let folderId: string;
    test('Create a new folder', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('folders', {
            data: {
                displayName: "API Test Flow Folder",
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
        expect.soft(body.displayName).toBe('API Test Flow Folder');
        expect.soft(body.projectId).toBe(session.projectId);

        folderId = body.id;

    });
    test('List folders', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('folders', {
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
        expect.soft(folder?.displayName).toBe('API Test Flow Folder');
        expect.soft(folder?.projectId).toBe(session.projectId);
    });
    test('Update an existing folder', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`folders/${folderId}`, {
            data: {
                displayName: "Updated API Test Flow Folder",
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.displayName).toBe('Updated API Test Flow Folder');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(body.id).toBe(folderId);
    });
    test('Get a folder by id', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`folders/${folderId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(folderId);
        expect.soft(body.displayName).toBe('Updated API Test Flow Folder');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');

    });

    test('Delete a folder', async ({ request }) => {
        console.log('Deleting folderId:', folderId);
        const responseStartTime = Date.now();
        const response = await request.delete(`folders/${folderId}`, {
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
