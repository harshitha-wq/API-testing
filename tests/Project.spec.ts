import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Projects', () => {
    test.describe.configure({ mode: 'serial' });

    const session = loadSession();
    let projectId: string;

    test('Create a new project', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('projects', {
            data: {
                displayName: 'API Test Project',
                externalId: 'api-test-project',
                metadata: {
                    additionalProp1: 'value1',
                    additionalProp2: 'value2',
                    additionalProp3: 'value3',
                },
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);

        const body = await response.json();

        console.log('Create project response:', body);

        // Project details
        expect.soft(body.id).toBeTruthy();
        expect.soft(typeof body.id).toBe('string');
        expect.soft(body.displayName).toBe('API Test Project');
        expect.soft(body.externalId).toBe('api-test-project');

        // Basic project fields
        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');
        expect.soft(typeof body.ownerId).toBe('string');
        expect.soft(typeof body.platformId).toBe('string');

        // Created and updated should be today's date
        const today = new Date().toISOString().split('T')[0];

        expect.soft(body.created.split('T')[0]).toBe(today);
        expect.soft(body.updated.split('T')[0]).toBe(today);

        // Project settings
        expect.soft(body.notifyStatus).toBe('ALWAYS');
        expect.soft(body.releasesEnabled).toBe(false);

        // Metadata
        expect.soft(body.metadata).toBeTruthy();
        expect.soft(body.metadata.additionalProp1).toBe('value1');
        expect.soft(body.metadata.additionalProp2).toBe('value2');
        expect.soft(body.metadata.additionalProp3).toBe('value3');

        // Usage
        expect.soft(body.usage).toBeTruthy();
        expect.soft(body.usage.tasks).toBe(0);
        expect.soft(body.usage.aiCredits).toBe(0);
        expect.soft(typeof body.usage.nextLimitResetDate).toBe('number');

        // Plan
        expect.soft(body.plan).toBeTruthy();
        expect.soft(typeof body.plan.id).toBe('string');
        expect.soft(body.plan.projectId).toBe(body.id);
        expect.soft(body.plan.locked).toBe(false);
        expect.soft(body.plan.name).toBe('platform');
        expect.soft(body.plan.piecesFilterType).toBe('NONE');
        expect.soft(body.plan.pieces).toEqual([]);
        expect.soft(body.plan.tasks).toBe(10000);
        expect.soft(body.plan.aiCredits).toBe(1000);

        // Analytics
        expect.soft(body.analytics).toBeTruthy();
        expect.soft(body.analytics.totalUsers).toBe(0);
        expect.soft(body.analytics.activeUsers).toBe(0);
        expect.soft(body.analytics.totalFlows).toBe(0);
        expect.soft(body.analytics.activeFlows).toBe(0);

        // Save project ID for later tests
        projectId = body.id;
    });


    test.skip('List projects', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('projects', {
            params: {
                externalId: 'api-test-project',
                limit: 10,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect(response.status()).toBe(200);

        const body = await response.json();

        console.log('Projects response:', body);

        expect.soft(Array.isArray(body.data)).toBe(true);
        expect.soft(typeof body.total).toBe('number');

        const project = body.data.find(
            (item: { id: string }) => item.id === projectId
        );

        expect.soft(project).toBeTruthy();

        expect.soft(project?.id).toBe(projectId);
        expect.soft(project?.displayName).toBe('API Test Project');
        expect.soft(project?.externalId).toBe('api-test-project');
    });




    test('Update an existing project', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`projects/${projectId}`, {
            data: {
                notifyStatus: 'NEVER',
                releasesEnabled: true,
                displayName: 'Updated API Test Project',
                externalId: 'updated-api-test-project',
                metadata: {
                    additionalProp1: 'updated-value1',
                    additionalProp2: 'updated-value2',
                    additionalProp3: 'updated-value3',
                },
                plan: {
                    tasks: 5000,
                    pieces: [],
                    piecesFilterType: 'NONE',
                    aiCredits: 500,
                },
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);

        const body = await response.json();

        console.log('Update project response:', body);

        // Project details
        expect.soft(body.id).toBe(projectId);
        expect.soft(body.displayName).toBe('Updated API Test Project');

        // Basic project fields
        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');
        expect.soft(typeof body.ownerId).toBe('string');
        expect.soft(typeof body.platformId).toBe('string');

        // Created should remain the original creation date
        const today = new Date().toISOString().split('T')[0];

        expect.soft(body.created.split('T')[0]).toBe(today);

        // Updated should be today's date
        expect.soft(body.updated.split('T')[0]).toBe(today);

        // Updated project settings
        expect.soft(body.notifyStatus).toBe('NEVER');
        expect.soft(body.releasesEnabled).toBe(true);

        // Updated external ID
        expect.soft(body.externalId).toBe('updated-api-test-project');

        // Updated metadata
        expect.soft(body.metadata).toBeTruthy();
        expect.soft(body.metadata.additionalProp1).toBe('updated-value1');
        expect.soft(body.metadata.additionalProp2).toBe('updated-value2');
        expect.soft(body.metadata.additionalProp3).toBe('updated-value3');

        // Plan
        expect.soft(body.plan).toBeTruthy();
        expect.soft(typeof body.plan.id).toBe('string');
        expect.soft(body.plan.projectId).toBe(projectId);
        expect.soft(body.plan.locked).toBe(false);
        expect.soft(body.plan.piecesFilterType).toBe('NONE');
        expect.soft(body.plan.pieces).toEqual([]);
        expect.soft(body.plan.tasks).toBe(5000);
        expect.soft(body.plan.aiCredits).toBe(500);

        // Usage
        expect.soft(body.usage).toBeTruthy();
        expect.soft(typeof body.usage.tasks).toBe('number');
        expect.soft(typeof body.usage.aiCredits).toBe('number');
        expect.soft(typeof body.usage.nextLimitResetDate).toBe('number');

        // Analytics
        expect.soft(body.analytics).toBeTruthy();
        expect.soft(typeof body.analytics.totalUsers).toBe('number');
        expect.soft(typeof body.analytics.activeUsers).toBe('number');
        expect.soft(typeof body.analytics.totalFlows).toBe('number');
        expect.soft(typeof body.analytics.activeFlows).toBe('number');
    });
    test('Delete a project', async ({ request }) => {
        console.log('Deleting projectId:', projectId);

        const responseStartTime = Date.now();
        const response = await request.delete(`projects/${projectId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}`, },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        console.log('Delete status:', response.status());
        console.log('Delete body:', await response.text());

        expect(response.status()).toBe(204);
    });

});
