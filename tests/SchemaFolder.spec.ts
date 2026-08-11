import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

test.describe('Schema Folders', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();
    

    let folderId: string;
    test('Create a new document schema folder', async ({ request }) => {
        const response = await request.post('document/schema-folders', {
            data: {
                displayName: "API Test Schema Folder",
                projectId: session.projectId,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.displayName).toBe('API Test Schema Folder');
        expect.soft(body.projectId).toBe(session.projectId);

        folderId = body.id;

    });
    test('List document schema folders', async ({ request }) => {
        const response = await request.get('document/schema-folders', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        console.log(body.data);
        expect.soft(body.data[0].id).toBe(folderId);
        expect.soft(body.data[0].displayName).toBe('API Test Schema Folder');
        expect.soft(body.data[0].projectId).toBe(session.projectId);
    });

    test('Rename a document schema folder', async ({ request }) => {
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

        expect(response.status()).toBe(200);

        const body = await response.json();

        expect(body.displayName).toBe('Updated API Test Schema Folder');
        expect(body.projectId).toBe(session.projectId);
        expect(body.id).toBe(folderId);
    });


    test('Get a document schema folder by id', async ({ request }) => {
        const response = await request.get(`document/schema-folders/${folderId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(folderId);
        expect.soft(body.displayName).toBe('Updated API Test Schema Folder');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');

    });

    test('Count schemas not assigned to any folder', async ({ request }) => {
        const response = await request.get(`document/schema-folders/uncategorized-count`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.count).toBe(0);
    });

    test('Delete a document schema folder', async ({ request }) => {
        console.log('Deleting folderId:', folderId);
        const response = await request.delete(`document/schema-folders/${folderId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}`, },
        });
        console.log('Delete status:', response.status());
        console.log('Delete body:', await response.text());
        expect(response.status()).toBe(200);
    });


});



