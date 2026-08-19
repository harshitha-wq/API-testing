import { test, expect, request as apiRequest } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config';
import { loadSession } from '../session';

const SAMPLE_INVOICE_PATH = path.join(__dirname, '..', 'Testdata', 'sample-invoice.pdf');
// Max acceptable response time for each API call below; every test times its
// request and asserts the duration against this.
const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Flow', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();

    let flowId: string;
    let folderId: string;
    let flowRunId: string;

    const FLOW_RUN_STATUSES = [
        'FAILED',
        'QUOTA_EXCEEDED',
        'INTERNAL_ERROR',
        'PAUSED',
        'QUEUED',
        'RUNNING',
        'SUCCEEDED',
        'MEMORY_LIMIT_EXCEEDED',
        'TIMEOUT',
    ];

    // POST /flows - creates a new flow in the project. A fresh flow starts DISABLED,
    // unpublished, and with an empty placeholder trigger until it's configured.
    test('Create a new flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('flows', {
            data: {
                displayName: 'API Test Flow',
                projectId: session.projectId,
                metadata: {
                    additionalProp1: 'value1',
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
        console.log('Create flow response:', body);

        expect.soft(typeof body.id).toBe('string');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.externalId).toBe('string');
        expect.soft(body.folderId).toBeNull();
        expect.soft(body.status).toBe('DISABLED');
        expect.soft(body.publishedVersionId).toBeNull();
        expect.soft(body.metadata).toEqual({ additionalProp1: 'value1' });

        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');

        // Version details for a freshly created flow
        expect.soft(body.version).toBeTruthy();
        expect.soft(body.version.flowId).toBe(body.id);
        expect.soft(body.version.displayName).toBe('API Test Flow');
        expect.soft(body.version.state).toBe('DRAFT');
        expect.soft(body.version.trigger.type).toBe('EMPTY');

        flowId = body.id;
    });

    // GET /flows - lists flows in a project, filterable by folder, status, name, etc.
    // Used here to confirm the flow just created shows up in the project's flow list.
    test('List flows', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('flows', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(Array.isArray(body.data)).toBe(true);

        const flow = body.data.find((item: { id: string }) => item.id === flowId);
        expect.soft(flow).toBeTruthy();
        expect.soft(flow?.projectId).toBe(session.projectId);
        expect.soft(flow?.version.displayName).toBe('API Test Flow');
    });

    // GET /flows/{id} - fetches a single flow's full details (entity + current version).
    test('Get a flow by id', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`flows/${flowId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(body.id).toBe(flowId);
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(body.version.displayName).toBe('API Test Flow');
    });

    // POST /flows/{id} (type: CHANGE_NAME) - renames the flow's current version.
    test('Apply CHANGE_NAME operation to a flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'CHANGE_NAME',
                request: {
                    displayName: 'Updated API Test Flow',
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

        expect.soft(body.id).toBe(flowId);
        expect.soft(body.version.displayName).toBe('Updated API Test Flow');
    });

    // POST /flows/{id} (type: CHANGE_FOLDER) - moves the flow into a folder (entity-level
    // field, separate from the version). Creates a throwaway folder via POST /folders first.
    test('Apply CHANGE_FOLDER operation to a flow', async ({ request }) => {
        const folderResponseStartTime = Date.now();
        const folderResponse = await request.post('folders', {
            data: {
                displayName: 'API Test Flow Folder for Flow',
                projectId: session.projectId,
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const folderResponseDurationMs = Date.now() - folderResponseStartTime;
        expect.soft(folderResponseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(folderResponse.status()).toBe(200);
        const folderBody = await folderResponse.json();
        folderId = folderBody.id;

        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'CHANGE_FOLDER',
                request: {
                    folderId,
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

        expect.soft(body.id).toBe(flowId);
        expect.soft(body.folderId).toBe(folderId);
    });

    // POST /flows/{id} (type: UPDATE_TRIGGER) - replaces the flow's trigger. Configures the
    // "Chat UI" trigger (piece @docxster/piece-forms, chat_submission), which exposes a
    // public chat widget/webhook and carries any user-attached file at trigger['files'][0].
    test('Apply UPDATE_TRIGGER operation to add a Chat UI trigger', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Chat UI',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: '@docxster/piece-forms',
                        pieceVersion: '0.6.1',
                        triggerName: 'chat_submission',
                        input: { botName: 'API Test Bot' },
                        inputUiInfo: {},
                    },
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

        expect.soft(body.id).toBe(flowId);
        expect.soft(body.version.trigger.type).toBe('PIECE_TRIGGER');
        expect.soft(body.version.trigger.displayName).toBe('Chat UI');
        expect.soft(body.version.trigger.valid).toBe(true);
        expect.soft(body.version.trigger.settings.pieceName).toBe('@docxster/piece-forms');
        expect.soft(body.version.trigger.settings.triggerName).toBe('chat_submission');
        expect.soft(body.version.trigger.settings.input).toEqual({ botName: 'API Test Bot' });
        expect.soft(body.version.valid).toBe(true);
    });

    // POST /flows/{id} (type: ADD_ACTION), again - adds "Document OCR" (piece
    // @docxster/piece-document-processing, process_documents) directly after the Chat UI
    // trigger, running AI extraction on the file the user attached in chat, against the
    // "Invoice" document schema. No separate Upload File step is needed - the file the
    // user attaches in the Chat UI is passed straight to OCR via trigger['files'][0].
    test('Apply ADD_ACTION operation to add a Document OCR step', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'trigger',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_2',
                        valid: true,
                        displayName: 'Document OCR',
                        type: 'PIECE',
                        settings: {
                            pieceName: '@docxster/piece-document-processing',
                            pieceVersion: '0.18.1',
                            actionName: 'process_documents',
                            input: {
                                files: "{{trigger['files'][0]}}",
                                schemaIds: { schemaIds: ['e9FTsPBNZk1psqmywiibU'] },
                                supportValidationPlatform: false,
                                supportMultiInstance: false,
                                enableHumanReview: false,
                            },
                            inputUiInfo: {},
                        },
                    },
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

        const ocrStep = body.version.trigger.nextAction;
        expect.soft(ocrStep).toBeTruthy();
        expect.soft(ocrStep.name).toBe('step_2');
        expect.soft(ocrStep.displayName).toBe('Document OCR');
        expect.soft(ocrStep.valid).toBe(true);
        expect.soft(ocrStep.settings.pieceName).toBe('@docxster/piece-document-processing');
        expect.soft(ocrStep.settings.actionName).toBe('process_documents');
        expect.soft(ocrStep.settings.input.schemaIds).toEqual({ schemaIds: ['e9FTsPBNZk1psqmywiibU'] });
        expect.soft(body.version.valid).toBe(true);
    });

    // POST /flows/{id} (type: LOCK_AND_PUBLISH) - locks the current draft version and
    // publishes it (publishedVersionId gets set, status becomes ENABLED). Required before
    // a flow can actually run - CHANGE_STATUS -> ENABLED alone fails until this has happened.
    test('Apply LOCK_AND_PUBLISH operation to publish the flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'LOCK_AND_PUBLISH',
                request: {
                    status: 'ENABLED',
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

        expect.soft(body.id).toBe(flowId);
        expect.soft(body.status).toBe('ENABLED');
        expect.soft(typeof body.publishedVersionId).toBe('string');
        expect.soft(body.version.state).toBe('LOCKED');
    });

    // POST /webhooks/{flowId} - the flow's public trigger URL (undocumented in /docs/ui,
    // separate from the authenticated management API). Simulates a user attaching a file
    // in the Chat UI widget by POSTing multipart form data (message + file) to it directly.
    test('Trigger the published flow via its chat webhook with a sample invoice', async () => {
        const webhookContext = await apiRequest.newContext({ baseURL: env.apiBaseUrl, extraHTTPHeaders: {} });
        const responseStartTime = Date.now();
        const response = await webhookContext.post(`webhooks/${flowId}`, {
            multipart: {
                message: 'Please process this invoice',
                files: {
                    name: 'sample-invoice.pdf',
                    mimeType: 'application/pdf',
                    buffer: fs.readFileSync(SAMPLE_INVOICE_PATH),
                },
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        await webhookContext.dispose();

        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(response.status()).toBe(200);
        expect.soft(response.headers()['x-webhook-id']).toBeTruthy();
    });

    // GET /flow-runs - lists flow runs for the project, filterable by flowId, status, tags,
    // etc. Runs are produced by triggering a flow (e.g. the webhook above) and are processed
    // asynchronously by a worker, so - rather than race that worker - this reads the
    // project's run history and picks the most recent entry to validate the response shape.
    test('List flow runs for the project', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('flow-runs', {
            params: { projectId: session.projectId, limit: 1 },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(Array.isArray(body.data)).toBe(true);
        expect.soft(body.data.length).toBe(1);

        const run = body.data[0];
        expect.soft(run.projectId).toBe(session.projectId);
        expect.soft(typeof run.id).toBe('string');
        expect.soft(typeof run.flowId).toBe('string');
        expect.soft(typeof run.flowVersionId).toBe('string');
        expect.soft(typeof run.flowDisplayName).toBe('string');
        expect.soft(FLOW_RUN_STATUSES).toContain(run.status);
        expect.soft(typeof run.startTime).toBe('string');

        flowRunId = run.id;
    });

    // GET /flow-runs/{id} - fetches a single flow run's full details, including its
    // per-step execution data (absent from the list endpoint above).
    test('Get a flow run by id', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`flow-runs/${flowRunId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(body.id).toBe(flowRunId);
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.flowId).toBe('string');
        expect.soft(typeof body.flowVersionId).toBe('string');
        expect.soft(typeof body.flowDisplayName).toBe('string');
        expect.soft(FLOW_RUN_STATUSES).toContain(body.status);
        expect.soft(typeof body.startTime).toBe('string');
        expect.soft('steps' in body).toBe(true);
    });

    // GET /flows/{id}/template - exports the flow's trigger/action chain as a reusable
    // template document (the format used by the flow-templates API / template gallery).
    test('Export flow as template', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`flows/${flowId}/template`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(body.name).toBe('Updated API Test Flow');
        expect.soft(body.template).toBeTruthy();
        expect.soft(body.template.displayName).toBe('Updated API Test Flow');
        expect.soft(Array.isArray(body.pieces)).toBe(true);
        expect.soft(body.pieces).toEqual(expect.arrayContaining([
            '@docxster/piece-forms',
            '@docxster/piece-document-processing',
        ]));

        // The Chat UI -> Document OCR chain should be preserved in the template
        expect.soft(body.template.trigger.settings.triggerName).toBe('chat_submission');
        expect.soft(body.template.trigger.nextAction.settings.actionName).toBe('process_documents');
    });

    // DELETE /flows/{id} - permanently deletes the flow. Also cleans up the folder
    // created earlier for the CHANGE_FOLDER test.
    test('Delete a flow', async ({ request }) => {
        console.log('Deleting flowId:', flowId);
        const responseStartTime = Date.now();
        const response = await request.delete(`flows/${flowId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        console.log('Delete status:', response.status());

        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect(response.status()).toBe(204);

        // Cleanup the folder created for the CHANGE_FOLDER test
        await request.delete(`folders/${folderId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}` },
        });
    });
});