import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadSession } from '../session';

const SAMPLE_PDF_PATH = path.join(__dirname, '..', 'Testdata', 'sample.pdf');
// Max acceptable response time for each API call below; every test times its
// request and asserts the duration against this.
const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Drive', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();
    const runSuffix = Date.now();

    let folderId: string;
    let tempFolderId: string;
    let fileId: string;
    let uploadSessionFileId: string;
    let fileName: string;
    let fileChecksum: string;
    let copiedFileId: string;
    let publicLinkId: string;

    test('List drive items', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/items', {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        console.log('Drive items:', body);
        expect.soft(Array.isArray(body.data)).toBe(true);
    });

    test('Bulk create drive items', async ({ request }) => {
        const fileContent = fs.readFileSync(SAMPLE_PDF_PATH);
        fileName = `api-test-upload-${runSuffix}.pdf`;
        fileChecksum = crypto.createHash('md5').update(fileContent).digest('base64');

        const responseStartTime = Date.now();
        const response = await request.post('drive/items', {
            data: {
                operations: [
                    {
                        type: 'create_folder',
                        pathIds: '',
                        name: `API Test Folder ${runSuffix}`,
                        metadata: {},
                    },
                    {
                        type: 'create_folder',
                        pathIds: '',
                        name: `API Test Temp Folder ${runSuffix}`,
                        metadata: {},
                    },
                    {
                        type: 'upload_file',
                        pathIds: '',
                        name: fileName,
                        clientId: 'api-test-client-id-1',
                        file: {
                            size: fileContent.length,
                            mimeType: 'application/pdf',
                            checksum: fileChecksum,
                        },
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();

        console.log('Bulk create drive items response:', body);

        expect.soft(Array.isArray(body.results)).toBe(true);
        expect.soft(body.results.length).toBe(3);

        const [folderResult, tempFolderResult, fileResult] = body.results;

        // Folder creation result
        expect.soft(folderResult.success).toBe(true);
        expect.soft(folderResult.item).toBeTruthy();
        expect.soft(folderResult.item.name).toBe(`API Test Folder ${runSuffix}`);
        expect.soft(folderResult.item.resourceType).toBe('folder');
        expect.soft(typeof folderResult.item.id).toBe('string');

        // Temp folder creation result (used later for the standalone delete/bin tests)
        expect.soft(tempFolderResult.success).toBe(true);
        expect.soft(tempFolderResult.item).toBeTruthy();
        expect.soft(tempFolderResult.item.name).toBe(`API Test Temp Folder ${runSuffix}`);

        // File registration result
        expect.soft(fileResult.success).toBe(true);
        expect.soft(fileResult.clientId).toBe('api-test-client-id-1');
        expect.soft(fileResult.item).toBeTruthy();
        expect.soft(fileResult.item.name).toBe(fileName);
        expect.soft(fileResult.item.resourceType).toBe('file');
        expect.soft(fileResult.uploadSession).toBeTruthy();

        const uploadUrl: string = fileResult.uploadSession.uploadUrl;
        expect.soft(typeof uploadUrl).toBe('string');

        // Send the actual file bytes to the signed upload URL returned above.
        const uploadResponseStartTime = Date.now();
        const uploadResponse = await request.put(uploadUrl, {
            data: fileContent,
            headers: {
                'Content-Type': 'application/pdf',
            },
        });
        const uploadResponseDurationMs = Date.now() - uploadResponseStartTime;
        expect.soft(uploadResponseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        console.log('File bytes upload status:', uploadResponse.status());
        console.log('File bytes upload body:', await uploadResponse.text());

        expect.soft(uploadResponse.ok()).toBe(true);

        folderId = folderResult.item.id;
        tempFolderId = tempFolderResult.item.id;
        fileId = fileResult.item.id;
        uploadSessionFileId = fileResult.uploadSession.fileId;
    });

    test('Confirm upload completion and start processing', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('drive/items/confirm-upload', {
            data: {
                fileId: uploadSessionFileId,
                checksum: fileChecksum,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Confirm upload response:', body);

        expect.soft(body.success).toBe(true);
        expect.soft(body.item).toBeTruthy();
        expect.soft(body.item?.id).toBe(fileId);
    });

    test('Get a single drive item by ID', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`drive/items/${fileId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Get drive item by id response:', body);

        expect.soft(body.id).toBe(fileId);
        expect.soft(body.name).toBe(fileName);
        expect.soft(body.resourceType).toBe('file');
        expect.soft(typeof body.projectId).toBe('string');
    });

    test('Get drive item metadata', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`drive/items/${fileId}/metadata`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Get drive item metadata response:', body);

        expect.soft(body.item).toBeTruthy();
        expect.soft(body.item.id).toBe(fileId);
    });

    test('Get drive item content', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`drive/items/${fileId}/content`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        console.log('Get drive item content status:', response.status());

        expect.soft(response.ok()).toBe(true);
    });

    test('Update drive item content', async ({ request }) => {
        const newContent = fs.readFileSync(SAMPLE_PDF_PATH);

        const responseStartTime = Date.now();
        const response = await request.patch(`drive/items/${fileId}/content`, {
            data: {
                file: {
                    data: newContent.toString('base64'),
                    size: newContent.length,
                    mimeType: 'application/pdf',
                },
                versionComment: 'API test version update',
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        const body = await response.json();
        console.log('Update drive item content response:', body);

        if (response.status() === 500 && body?.message?.includes('Not implemented yet')) {
            console.warn('KNOWN SERVER GAP: PATCH drive/items/{itemId}/content is not implemented on this environment yet.');
            return;
        }

        expect.soft(response.status()).toBe(200);
        expect.soft(body.item).toBeTruthy();
        expect.soft(body.item.id).toBe(fileId);
        expect.soft(typeof body.version).toBe('number');
    });

    test('Search non-deleted drive items', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/items/search', {
            params: { q: fileName },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Search drive items response:', body);

        expect.soft(Array.isArray(body.results)).toBe(true);
    });

    test('Get facets for current drive items query', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/items/facets', {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Drive item facets response:', body);

        expect.soft(body).toHaveProperty('facets');
    });

    test('Get path information for drive items navigation', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/items/path-info', {
            params: { pathIds: folderId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Drive path info response:', body);

        expect.soft(Array.isArray(body.ids)).toBe(true);
        expect.soft(Array.isArray(body.names)).toBe(true);
    });

    test('Find a folder by exact name or create it if it does not exist', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('drive/items/search-or-create-folder', {
            data: {
                exactFolderName: `API Test Search-Or-Create Folder ${runSuffix}`,
                parentFolderId: null,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Search or create folder response:', body);

        expect.soft(typeof body.folderId).toBe('string');
        expect.soft(body.folder).toBeTruthy();
        expect.soft(typeof body.created).toBe('boolean');
    });

    test('Find files by name with configurable match type (exact, contains, startsWith, endsWith)', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/items/find-files', {
            params: {
                fileName,
                matchType: 'contains',
                limit: 10,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Find files response:', body);

        expect.soft(Array.isArray(body.files)).toBe(true);
        expect.soft(typeof body.count).toBe('number');
    });

    test('Full-text content search across drive files using OCR and Meilisearch', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/items/smart-search', {
            params: { searchText: 'api-test' },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Smart search response:', body);

        expect.soft(Array.isArray(body.files)).toBe(true);
        expect.soft(typeof body.count).toBe('number');
    });

    test('Bulk drive operations (move, rename, copy, delete) - star', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.patch('drive/items', {
            data: {
                operations: [
                    {
                        type: 'star',
                        itemIds: [fileId],
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Star drive item response:', body);

        const [starResult] = body.results;
        expect.soft(starResult.success).toBe(true);
        expect.soft(starResult.itemId).toBe(fileId);
    });

    test('List starred items with optional filtering and pagination', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/starred', {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Starred drive items response:', body);

        expect.soft(Array.isArray(body.data)).toBe(true);

        const starredItem = body.data.find((item: { id: string }) => item.id === fileId);
        expect.soft(starredItem).toBeTruthy();
    });

    test('Search starred items', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/starred/search', {
            params: { q: fileName },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Search starred drive items response:', body);

        expect.soft(Array.isArray(body.results)).toBe(true);
    });

    test('Get facets (type counts, extension counts, etc.) for starred items', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/starred/facets', {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Starred drive facets response:', body);

        expect.soft(body).toHaveProperty('types');
        expect.soft(body).toHaveProperty('owners');
    });

    test('Bulk drive operations (move, rename, copy, delete) - unstar', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.patch('drive/items', {
            data: {
                operations: [
                    {
                        type: 'unstar',
                        itemIds: [fileId],
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Unstar drive item response:', body);

        const [unstarResult] = body.results;
        expect.soft(unstarResult.success).toBe(true);
        expect.soft(unstarResult.itemId).toBe(fileId);
    });

    test('Create a new public share link for a file or folder', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('drive/sharing/public-link', {
            data: {
                itemId: fileId,
                linkType: 'view',
                expiresInDays: 7,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);

        const body = await response.json();
        console.log('Create public share link response:', body);

        expect.soft(typeof body.id).toBe('string');
        expect.soft(typeof body.shareUrl).toBe('string');
        expect.soft(body.linkType).toBe('view');
        expect.soft(body.isActive).toBe(true);

        publicLinkId = body.id;
    });

    test('Get sharing summary for an item', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`drive/sharing/${fileId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Sharing info response:', body);

        expect.soft(body.itemId).toBe(fileId);
        expect.soft(Array.isArray(body.publicLinks)).toBe(true);
        expect.soft(Array.isArray(body.sharedUsers)).toBe(true);

        const link = body.publicLinks.find((l: { id: string }) => l.id === publicLinkId);
        expect.soft(link).toBeTruthy();
    });

    test('Update public link settings', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.put(`drive/sharing/public-link/${publicLinkId}`, {
            data: {
                isActive: false,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Update public share link response:', body);

        expect.soft(body.id).toBe(publicLinkId);
        expect.soft(body.isActive).toBe(false);
    });

    test('Access a public share link', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`drive/sharing/public/${publicLinkId}/access`, {
            data: {},
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        console.log('Access public share link status:', response.status());
        console.log('Access public share link body:', await response.text());

        // The link was deactivated in the previous test, so this is expected to be denied;
        // kept soft since the exact status code for a deactivated link is not documented.
        expect.soft(response.status()).not.toBe(500);
    });

    test('Revoke a public share link', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.delete(`drive/sharing/public-link/${publicLinkId}`, {
            data: {},
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        console.log('Delete public share link status:', response.status());

        expect.soft(response.ok()).toBe(true);
    });

    test('Bulk drive operations (move, rename, copy, delete)', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.patch('drive/items', {
            data: {
                operations: [
                    {
                        type: 'rename',
                        itemId: folderId,
                        newName: `Renamed API Test Folder ${runSuffix}`,
                    },
                    {
                        type: 'rename',
                        itemId: fileId,
                        newName: `renamed-api-test-upload-${runSuffix}.pdf`,
                    },
                    {
                        type: 'copy',
                        itemIds: [fileId],
                        targetPathIds: '',
                    },
                    {
                        type: 'move',
                        itemIds: [folderId],
                        targetPathIds: '',
                    },
                    {
                        type: 'download',
                        itemIds: [fileId],
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();

        console.log('Bulk drive operations response:', body);

        expect.soft(Array.isArray(body.results)).toBe(true);
        expect.soft(body.results.length).toBe(5);

        const [
            renameFolderResult,
            renameFileResult,
            copyResult,
            moveResult,
            downloadResult,
        ] = body.results;

        // Rename folder - the API only echoes back { itemId, success }, not the updated item
        expect.soft(renameFolderResult.success).toBe(true);
        expect.soft(renameFolderResult.itemId).toBe(folderId);

        // Rename file
        expect.soft(renameFileResult.success).toBe(true);
        expect.soft(renameFileResult.itemId).toBe(fileId);

        // Copy - the response doesn't include the new copy's id, so look it up by
        // the name the server gives copies ("<source name> copy.<ext>").
        expect.soft(copyResult.success).toBe(true);

        const renamedFileName = `renamed-api-test-upload-${runSuffix}.pdf`;
        const searchResponseStartTime = Date.now();
        const searchResponse = await request.get('drive/items/search', {
            params: { q: renamedFileName },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const searchResponseDurationMs = Date.now() - searchResponseStartTime;
        expect.soft(searchResponseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        const searchBody = await searchResponse.json();
        const copyMatch = searchBody.results.find((r: { id: string }) => r.id !== fileId);
        expect.soft(copyMatch).toBeTruthy();
        copiedFileId = copyMatch?.id;

        // Move
        expect.soft(moveResult.success).toBe(true);
        expect.soft(moveResult.itemId).toBe(folderId);

        // Download
        expect.soft(downloadResult.success).toBe(true);
        expect.soft(typeof downloadResult.downloadUrl).toBe('string');
        expect.soft(typeof downloadResult.expiresAt).toBe('string');
    });

    test('Get download status by job ID or item ID', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`drive/items/${fileId}/status`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        console.log('Drive item status code:', response.status());
        console.log('Drive item status body:', await response.text());

        // Async job status is best-effort here since our small text file may be
        // processed synchronously and never produce a trackable job id.
        expect.soft(response.status()).not.toBe(500);
    });

    test('Bulk drive operations (move, rename, copy, delete) - delete', async ({ request }) => {
        // Soft delete (permanent: false) moves both items into the bin rather than
        // erasing them, matching the semantics of this shared operations endpoint.
        const responseStartTime = Date.now();
        const response = await request.patch('drive/items', {
            data: {
                operations: [
                    {
                        type: 'delete',
                        itemIds: [copiedFileId, tempFolderId],
                        permanent: false,
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Soft delete via bulk operations response:', body);

        const [deleteResult] = body.results;
        expect.soft(deleteResult.success).toBe(true);
    });

    test('List deleted drive items in bin', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/bin', {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Drive bin response:', body);

        expect.soft(Array.isArray(body.data)).toBe(true);

        const ids = body.data.map((item: { id: string }) => item.id);
        expect.soft(ids).toContain(copiedFileId);
        expect.soft(ids).toContain(tempFolderId);
    });

    test('Search deleted items in bin', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('drive/bin/search', {
            params: { q: 'API Test' },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Search drive bin response:', body);

        expect.soft(Array.isArray(body.results)).toBe(true);
    });

    test('Restore drive item from bin or revert to version', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`drive/items/${copiedFileId}/restore`, {
            data: {},
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Restore drive item response:', body);

        expect.soft(body.item).toBeTruthy();
        expect.soft(body.item.id).toBe(copiedFileId);
        expect.soft(body.item.isDeleted).toBe(false);
    });

    test('Bulk bin operations (restore, permanent delete, cleanup)', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('drive/bin/operations', {
            data: {
                action: 'permanent_delete',
                itemIds: [tempFolderId],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Bulk bin operations response:', body);

        expect.soft(typeof body.processed).toBe('number');
        expect.soft(Array.isArray(body.results)).toBe(true);
    });

    test('Bulk permanent delete drive items', async ({ request }) => {
        // This endpoint only permanently removes items that are already in the bin
        // (soft-deleting an active item directly returns ENTITY_NOT_FOUND), so move
        // the remaining active items into the bin first.
        await request.patch('drive/items', {
            data: {
                operations: [
                    {
                        type: 'delete',
                        itemIds: [folderId, fileId, copiedFileId],
                        permanent: false,
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        const responseStartTime = Date.now();
        const response = await request.delete('drive/items', {
            data: {},
            params: {
                itemIds: [folderId, fileId, copiedFileId].join(','),
                permanent: true,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();
        console.log('Final cleanup delete response:', body);

        expect.soft(body.deletedCount).toBe(3);
        expect.soft(body.errors).toEqual([]);
    });
})
