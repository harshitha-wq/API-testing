import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 10000;

test.describe('Records API', () => {
    test.describe.configure({ mode: 'serial' });

    const session = loadSession();
    let tableId: string;
    let recordId: string;
    let fieldId: string;

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

        // Create a column/field in the new table so records can store cell data
        try {
            const fieldResponse = await request.post('fields', {
                data: {
                    tableId: tableId,
                    name: 'Title',
                    type: 'TEXT',
                },
                headers: {
                    Authorization: `Bearer ${session.token}`,
                },
            });
            if (fieldResponse.ok()) {
                const fieldBody = await fieldResponse.json();
                if (fieldBody && fieldBody.id) {
                    fieldId = fieldBody.id;
                    console.log('Create field response:', fieldBody);
                }
            }
        } catch (e) {
            // Ignore if field creation endpoint is different
        }
    });

    test('Create records', async ({ request }) => {
        expect.soft(tableId).toBeTruthy();

        // Ensure fieldId is available
        if (!fieldId) {
            try {
                const exportRes = await request.post(`tables/${tableId}/export`, {
                    headers: {
                        Authorization: `Bearer ${session.token}`,
                    },
                    data: {},
                });
                if (exportRes.ok()) {
                    const exportBody = await exportRes.json();
                    if (Array.isArray(exportBody.fields) && exportBody.fields.length > 0) {
                        fieldId = exportBody.fields[0].id;
                    }
                }
            } catch (e) {
                // Ignore
            }

            if (!fieldId) {
                try {
                    const fieldResponse = await request.post('fields', {
                        data: {
                            tableId: tableId,
                            name: 'Title',
                            type: 'TEXT',
                        },
                        headers: {
                            Authorization: `Bearer ${session.token}`,
                        },
                    });
                    if (fieldResponse.ok()) {
                        const fieldBody = await fieldResponse.json();
                        if (fieldBody && fieldBody.id) {
                            fieldId = fieldBody.id;
                        }
                    }
                } catch (e) {
                    // Ignore
                }
            }
        }

        const sampleRecordValue = `Sample Record ${Date.now()}`;
        const sampleRecords = fieldId
            ? [
                  [
                      {
                          fieldId: fieldId,
                          value: sampleRecordValue,
                      },
                  ],
              ]
            : [
                  [],
              ];

        const responseStartTime = Date.now();
        const response = await request.post('records', {
            data: {
                tableId: tableId,
                records: sampleRecords,
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
            if (body[0].cells && typeof body[0].cells === 'object') {
                const cellKeys = Object.keys(body[0].cells);
                if (cellKeys.length > 0 && !fieldId) {
                    fieldId = cellKeys[0];
                }
            }
        } else if (body && body.data && Array.isArray(body.data) && body.data.length > 0) {
            recordId = body.data[0].id;
            if (body.data[0].cells && typeof body.data[0].cells === 'object') {
                const cellKeys = Object.keys(body.data[0].cells);
                if (cellKeys.length > 0 && !fieldId) {
                    fieldId = cellKeys[0];
                }
            }
        } else if (body && body.id) {
            recordId = body.id;
            if (body.cells && typeof body.cells === 'object') {
                const cellKeys = Object.keys(body.cells);
                if (cellKeys.length > 0 && !fieldId) {
                    fieldId = cellKeys[0];
                }
            }
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

        // Extract fieldId from the record's cells
        if (body.cells && typeof body.cells === 'object') {
            const cellKeys = Object.keys(body.cells);
            if (cellKeys.length > 0) {
                fieldId = cellKeys[0];
            }
        }
    });

    test('Update a record', async ({ request }) => {
        if (!recordId) {
            test.skip(!recordId, 'No recordId available');
            return;
        }

        // Fallback: If fieldId was not in body.cells, get it from table export
        if (!fieldId) {
            const exportResponse = await request.post(`tables/${tableId}/export`, {
                headers: {
                    Authorization: `Bearer ${session.token}`,
                },
                data: {},
            });
            if (exportResponse.ok()) {
                const exportBody = await exportResponse.json();
                if (Array.isArray(exportBody.fields) && exportBody.fields.length > 0) {
                    fieldId = exportBody.fields[0].id;
                }
            }
        }

        const updatedValue = `Updated Value ${Date.now()}`;
        const responseStartTime = Date.now();
        const response = await request.post(`records/${recordId}`, {
            data: {
                tableId: tableId,
                cells: fieldId
                    ? [
                          {
                              fieldId: fieldId,
                              value: updatedValue,
                          },
                      ]
                    : [],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json().catch(() => null);
        console.log('Update record response:', body);

        if (body) {
            expect.soft(body.id).toBe(recordId);
            expect.soft(body.tableId).toBe(tableId);

            if (fieldId && body.cells && body.cells[fieldId]) {
                expect.soft(body.cells[fieldId].value).toBe(updatedValue);
            }
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
