import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { loadSession } from '../session';

const SAMPLE_INVOICE_PATH = path.join(__dirname, '..', 'Testdata', 'sample-invoice.pdf');
const UNSUPPORTED_FORMAT_PATH = path.join(__dirname, '..', 'Testdata', 'unsupported-format.txt');
const INVOICE_20PAGE_PATH = path.join(__dirname, '..', 'Testdata', 'invoice-20page.pdf');
const INVOICE_30PAGE_PATH = path.join(__dirname, '..', 'Testdata', 'invoice-30page.pdf');
const INVOICE_60PAGE_PATH = path.join(__dirname, '..', 'Testdata', 'invoice-60page.pdf');
const INVOICE_PROTECTED_PATH = path.join(__dirname, '..', 'Testdata', 'invoice-protected.pdf');
const RESPONSE_TIME_LIMIT_MS = 2500;
const RUN_POLL_TIMEOUT_MS = 30_000;
const LARGE_RUN_POLL_TIMEOUT_MS = 90_000; // 20/60-page runs take noticeably longer than a single-page OCR call

const PIECE_NAME = '@docxster/piece-document-processing';
const PIECE_VERSION = '0.18.6';
const SPLIT_ACTION_NAME = 'process_documents_per_page';
const CLASSIFY_ACTION_NAME = 'classify_documents';
const DOC_OCR_LARGE_ACTION_NAME = 'process_documents_v2';
const ENABLE_HUMAN_REVIEW_ACTION_NAME = 'enable_human_review';
const SCHEMA_NAME = 'Invoice';

async function waitForRunFinished(request: any, auth: Record<string, string>, runId: string, timeoutMs: number): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const response = await request.get(`flow-runs/${runId}`, { headers: auth });
        // Fail fast on a non-2xx (e.g. an invalidated/expired session token)
        // instead of looping until timeout: confirmed against staging that an
        // auth failure here looks identical to "still running" - `body.status`
        // is simply undefined - so a run that will never resolve otherwise
        // silently burns the full timeout before failing with a confusing
        // "did not finish" error that has nothing to do with the actual cause.
        if (!response.ok()) {
            throw new Error(`GET flow-runs/${runId} failed: ${response.status()} ${await response.text()}`);
        }
        const body = await response.json();
        // Confirmed against staging: `status` (both the run's and a step's) can
        // flip to a terminal value before the step record is fully written - first
        // observed as `steps: {}` right after a terminal `status`, then again as a
        // step key present but its `output`/`errorMessage` still missing (e.g. a
        // PAUSED step with no `output` yet). So wait for the actually-tested step
        // (the one entry beyond `trigger`) to carry either field before returning.
        const testedStep = Object.entries(body.steps ?? {}).find(([name]) => name !== 'trigger')?.[1] as
            | { output?: unknown; errorMessage?: unknown }
            | undefined;
        const stepDataLanded = testedStep !== undefined && (testedStep.output !== undefined || testedStep.errorMessage !== undefined);
        if (body.status !== 'QUEUED' && body.status !== 'RUNNING' && stepDataLanded) {
            return body;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Flow run ${runId} did not finish within ${timeoutMs}ms`);
}

test.describe('Docxster OCR piece', () => {
    // timeout raised from the 30s default: several tests here poll a real
    // document-processing run (RUN_POLL_TIMEOUT_MS / LARGE_RUN_POLL_TIMEOUT_MS
    // below), and the Playwright test timeout was previously equal to or below
    // that poll allowance - so the harness killed the test before our own
    // polling loop ever got to time out with a clearer message.
    test.describe.configure({ mode: 'serial', timeout: 120_000 });
    const session = loadSession();
    const auth = { Authorization: `Bearer ${session.token}` };

    let flowId: string;
    let flowVersionId: string;
    let schemaId: string;
    let secondSchemaId: string;
    let documentReviewSessionId: string;
    let assigneeId: string;

    // Creates a new draft flow that is used as the container for all
    // Docxster Document Processing actions covered by this test suite.
    test('Create flow for Docxster OCR suite', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('flows', {
            data: {
                displayName: 'API Test - Docxster OCR',
                projectId: session.projectId,
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);
        const body = await response.json();
        console.log('Create flow response:', body);

        expect.soft(typeof body.id).toBe('string');
        expect.soft(body.version.state).toBe('DRAFT');

        flowId = body.id;
        flowVersionId = body.version.id;
    });

    // Resolves two existing document schemas already present on the project, reused
    // as the `schemaIds` every Docxster OCR action below needs to extract or
    // classify against.
    test('Resolve existing document schemas to use for extraction and classification', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('document/schemas', {
            params: { projectId: session.projectId },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const invoiceSchema = body.find((s: { id: string; name: string }) => s.name === SCHEMA_NAME);
        expect.soft(invoiceSchema).toBeTruthy();
        schemaId = invoiceSchema.id;

        const otherSchema = body.find((s: { id: string }) => s.id !== schemaId);
        expect.soft(otherSchema).toBeTruthy();
        secondSchemaId = otherSchema.id;
    });

    // Add "Split Document and OCR" — empty input
    // Enforce required fileUrls/schemaIds
    test('Add "Split Document and OCR" action with empty input - action is invalid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'trigger',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_1',
                        valid: true,
                        displayName: 'Split Document and OCR',
                        type: 'PIECE',
                        settings: {
                            pieceName: PIECE_NAME,
                            pieceVersion: PIECE_VERSION,
                            actionName: SPLIT_ACTION_NAME,
                            input: {},
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction;
        expect.soft(step).toBeTruthy();
        expect.soft(step.name).toBe('step_1');
        expect.soft(step.settings.actionName).toBe(SPLIT_ACTION_NAME);
        expect.soft(step.valid).toBe(false);
        expect.soft(body.version.valid).toBe(false);

        flowVersionId = body.version.id;
    });

    // Update "Split Document and OCR" — valid input
    // Fill fileUrls (array) + schemaIds + per-page flags
    test('Fill file and schema - action becomes valid', async ({ request }) => {
        const fileDataUri = `data:application/pdf;base64,${fs.readFileSync(SAMPLE_INVOICE_PATH).toString('base64')}`;

        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_1',
                    valid: true,
                    displayName: 'Split Document and OCR',
                    type: 'PIECE',
                    settings: {
                        pieceName: PIECE_NAME,
                        pieceVersion: PIECE_VERSION,
                        actionName: SPLIT_ACTION_NAME,
                        input: {
                            fileUrls: [{ file: fileDataUri }],
                            schemaIds: { schemaIds: [schemaId] },
                        },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction;
        expect.soft(step.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // Execute "Split Document and OCR" & verify per-page consolidation
    // Confirm each PDF page becomes its own classified instance, consolidated into one review
    test('Execute "Split Document and OCR" and verify per-page consolidated review', async ({ request }) => {
        const responseStartTime = Date.now();
        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();
        expect.soft(typeof testStepBody.id).toBe('string');

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        console.log('Split Document and OCR run:', JSON.stringify(runDetail.steps?.step_1, null, 2));

        expect.soft(runDetail.status).toBe('SUCCEEDED');

        const output = runDetail.steps?.step_1?.output;
        expect.soft(output).toBeTruthy();
        expect.soft(typeof output.reviewSessionId).toBe('string');

        const instances = output[SCHEMA_NAME];
        expect.soft(Array.isArray(instances)).toBe(true);
        expect.soft(instances.length).toBeGreaterThan(0);
        expect.soft(typeof instances[0].instanceId).toBe('string');
        expect.soft(instances[0].labels).toBeTruthy();

        documentReviewSessionId = output.reviewSessionId;
    });

    // Add "Classify Document" — empty input
    // Enforce required files/schemaIds
    test('Add "Classify Document" action with empty input - action is invalid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'step_1',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_2',
                        valid: true,
                        displayName: 'Classify Document',
                        type: 'PIECE',
                        settings: {
                            pieceName: PIECE_NAME,
                            pieceVersion: PIECE_VERSION,
                            actionName: CLASSIFY_ACTION_NAME,
                            input: {},
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction.nextAction;
        expect.soft(step).toBeTruthy();
        expect.soft(step.name).toBe('step_2');
        expect.soft(step.settings.actionName).toBe(CLASSIFY_ACTION_NAME);
        expect.soft(step.valid).toBe(false);

        flowVersionId = body.version.id;
    });

    // Update "Classify Document" — valid input
    // Fill files + candidate schemaIds
    test('Fill file and candidate schemas - Classify Document action becomes valid', async ({ request }) => {
        const fileDataUri = `data:application/pdf;base64,${fs.readFileSync(SAMPLE_INVOICE_PATH).toString('base64')}`;

        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_2',
                    valid: true,
                    displayName: 'Classify Document',
                    type: 'PIECE',
                    settings: {
                        pieceName: PIECE_NAME,
                        pieceVersion: PIECE_VERSION,
                        actionName: CLASSIFY_ACTION_NAME,
                        input: {
                            files: fileDataUri,
                            schemaIds: { schemaIds: [schemaId, secondSchemaId] },
                        },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction.nextAction;
        expect.soft(step.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // Execute "Classify Document" & verify verdict
    // Confirm classify-only behavior — no extraction, just a matched-schema verdict
    test('Execute "Classify Document" and verify classification verdict', async ({ request }) => {
        const responseStartTime = Date.now();
        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_2' },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();
        expect.soft(typeof testStepBody.id).toBe('string');

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        console.log('Classify Document run:', JSON.stringify(runDetail.steps?.step_2, null, 2));

        expect.soft(runDetail.status).toBe('SUCCEEDED');

        const output = runDetail.steps?.step_2?.output;
        expect.soft(Array.isArray(output)).toBe(true);
        expect.soft(output.length).toBeGreaterThan(0);

        const verdict = output[0];
        expect.soft(verdict.document_type_id).toBe(schemaId);
        expect.soft(typeof verdict.confidence).toBe('number');
        expect.soft(verdict.confidence).toBeGreaterThanOrEqual(0);
        expect.soft(verdict.confidence).toBeLessThanOrEqual(1);
        // Classify-only: no extracted field data, unlike process_documents/process_documents_per_page.
        expect.soft(verdict.labels).toBeUndefined();
    });

    // Add "Document OCR Large (beta)" — empty input
    // Enforce required files/schemaIds on the chunked-pipeline variant
    test('Add "Document OCR Large (beta)" action with empty input - action is invalid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'step_2',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_3',
                        valid: true,
                        displayName: 'Document OCR Large (beta)',
                        type: 'PIECE',
                        settings: {
                            pieceName: PIECE_NAME,
                            pieceVersion: PIECE_VERSION,
                            actionName: DOC_OCR_LARGE_ACTION_NAME,
                            input: {},
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction.nextAction.nextAction;
        expect.soft(step).toBeTruthy();
        expect.soft(step.name).toBe('step_3');
        expect.soft(step.settings.actionName).toBe(DOC_OCR_LARGE_ACTION_NAME);
        expect.soft(step.valid).toBe(false);

        flowVersionId = body.version.id;
    });

    // Update "Document OCR Large" — valid input
    // Fill required fields plus the v2-only reviewSessionId prop
    test('Fill file and schema - Document OCR Large action becomes valid', async ({ request }) => {
        const fileDataUri = `data:application/pdf;base64,${fs.readFileSync(SAMPLE_INVOICE_PATH).toString('base64')}`;

        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_3',
                    valid: true,
                    displayName: 'Document OCR Large (beta)',
                    type: 'PIECE',
                    settings: {
                        pieceName: PIECE_NAME,
                        pieceVersion: PIECE_VERSION,
                        actionName: DOC_OCR_LARGE_ACTION_NAME,
                        input: {
                            files: fileDataUri,
                            schemaIds: { schemaIds: [schemaId] },
                            supportValidationPlatform: false,
                            supportMultiInstance: false,
                            enableHumanReview: false,
                            reviewSessionId: '',
                        },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction.nextAction.nextAction;
        expect.soft(step.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // Execute "Document OCR Large" & verify chunked run
    // Confirm the beta pipeline actually returns for a >1-page document
    test('Execute "Document OCR Large" and verify chunked-pipeline extraction output', async ({ request }) => {
        const responseStartTime = Date.now();
        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_3' },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();
        expect.soft(typeof testStepBody.id).toBe('string');

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        console.log('Document OCR Large run:', JSON.stringify(runDetail.steps?.step_3, null, 2));

        expect.soft(runDetail.status).toBe('SUCCEEDED');

        const instance = runDetail.steps?.step_3?.output?.[SCHEMA_NAME];
        expect.soft(instance).toBeTruthy();
        expect.soft(typeof instance.instanceId).toBe('string');
        expect.soft(instance.labels).toBeTruthy();
    });

    // Resolve Assignee dynamic prop (enableHumanReview → assignee)
    // Confirm the DYNAMIC assignee prop shared by 3 actions resolves correctly
    test('Resolve Assignee dynamic prop for human review', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('pieces/options', {
            data: {
                pieceName: PIECE_NAME,
                pieceVersion: PIECE_VERSION,
                actionOrTriggerName: DOC_OCR_LARGE_ACTION_NAME,
                propertyName: 'assignee',
                projectId: session.projectId,
                flowId,
                flowVersionId,
                input: { enableHumanReview: true },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const assigneeIdsProp = body.options?.assigneeIds;
        expect.soft(assigneeIdsProp).toBeTruthy();
        expect.soft(assigneeIdsProp.type).toBe('STATIC_MULTI_SELECT_DROPDOWN');
        const options = assigneeIdsProp.options?.options;
        expect.soft(Array.isArray(options)).toBe(true);
        expect.soft(options.length).toBeGreaterThan(0);

        assigneeId = options[0].value;
    });

    // Add "Enable Human Review" — empty input
    // Enforce required reviewSessionId + data
    test('Add "Enable Human Review" action with empty input - action is invalid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'step_3',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_4',
                        valid: true,
                        displayName: 'Enable Human Review',
                        type: 'PIECE',
                        settings: {
                            pieceName: PIECE_NAME,
                            pieceVersion: PIECE_VERSION,
                            actionName: ENABLE_HUMAN_REVIEW_ACTION_NAME,
                            input: {},
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction.nextAction.nextAction.nextAction;
        expect.soft(step).toBeTruthy();
        expect.soft(step.name).toBe('step_4');
        expect.soft(step.settings.actionName).toBe(ENABLE_HUMAN_REVIEW_ACTION_NAME);
        expect.soft(step.valid).toBe(false);

        flowVersionId = body.version.id;
    });

    // Update "Enable Human Review" — valid input
    // Pair with a real prior OCR step's reviewSessionId, per the action's own description
    test('Fill reviewSessionId, data, and assignee - Enable Human Review action becomes valid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_4',
                    valid: true,
                    displayName: 'Enable Human Review',
                    type: 'PIECE',
                    settings: {
                        pieceName: PIECE_NAME,
                        pieceVersion: PIECE_VERSION,
                        actionName: ENABLE_HUMAN_REVIEW_ACTION_NAME,
                        input: {
                            reviewSessionId: documentReviewSessionId,
                            data: { invoice_number: 'INV-2026-0814' },
                            assignee: { assigneeIds: [assigneeId] },
                        },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const step = body.version.trigger.nextAction.nextAction.nextAction.nextAction;
        expect.soft(step.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // Execute "Enable Human Review" & verify flow pauses
    // Confirm run status reflects a paused-for-review state
    test('Execute "Enable Human Review" and verify the run pauses for review', async ({ request }) => {
       
        const responseStartTime = Date.now();
        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_4' },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();
        expect.soft(typeof testStepBody.id).toBe('string');

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        console.log('Enable Human Review run:', JSON.stringify(runDetail.steps?.step_4, null, 2));

        
        expect.soft(runDetail.status).toBe('PAUSED');

       
        const output = runDetail.steps?.step_4?.output;
        expect.soft(output).toBeTruthy();
        expect.soft(output.reviewSessionId).toBe(documentReviewSessionId);
    });

    // Cleanup — delete flow
    // Remove the suite's scratch flow
    test('Delete the flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.delete(`flows/${flowId}`, { data: {}, headers: auth });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(204);
    });
});

test.describe('Split Document and OCR edge cases', () => {
    test.describe.configure({ timeout: 120_000 });
    const session = loadSession();
    const auth = { Authorization: `Bearer ${session.token}` };

    // Resolved once and reused read-only by every test - safe without serial
    // mode since it's never written to after beforeAll.
    let schemaId: string;

    test.beforeAll(async ({ request }) => {
        const response = await request.get('document/schemas', {
            params: { projectId: session.projectId },
            headers: auth,
        });
        const body = await response.json();
        const invoiceSchema = body.find((s: { id: string; name: string }) => s.name === SCHEMA_NAME);
        schemaId = invoiceSchema.id;
    });

    // Per-test flow: beforeEach/afterEach run immediately before/after their
    // own test only, so this state never crosses into another test even
    // without serial mode.
    let flowId: string;
    let flowVersionId: string;

    test.beforeEach(async ({ request }) => {
        const flowResponse = await request.post('flows', {
            data: {
                displayName: 'API Test - Split Document and OCR edge cases',
                projectId: session.projectId,
            },
            headers: auth,
        });
        const flowBody = await flowResponse.json();
        flowId = flowBody.id;

        // Confirmed against staging: UPDATE_ACTION targeting a step name that
        // doesn't exist yet does NOT create it - it returns 200 but the
        // trigger's nextAction is silently never attached, so a later
        // sample-data/test-step call against that step name has nothing real
        // to execute and the run sits at RUNNING/QUEUED forever. ADD_ACTION is
        // the only reliable way to create step_1; every test's own
        // updateSplitAction() call then safely UPDATE_ACTIONs a step that's
        // now guaranteed to already exist.
        const addResponse = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'trigger',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_1',
                        valid: true,
                        displayName: 'Split Document and OCR',
                        type: 'PIECE',
                        settings: {
                            pieceName: PIECE_NAME,
                            pieceVersion: PIECE_VERSION,
                            actionName: SPLIT_ACTION_NAME,
                            input: {},
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        const addBody = await addResponse.json();
        flowVersionId = addBody.version.id;
    });

    test.afterEach(async ({ request }) => {
        await request.delete(`flows/${flowId}`, { data: {}, headers: auth });
    });

    function fileDataUri(filePath: string, mimeType: string): string {
        return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
    }

    async function updateSplitAction(request: any, input: Record<string, unknown>): Promise<any> {
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_1',
                    valid: true,
                    displayName: 'Split Document and OCR',
                    type: 'PIECE',
                    settings: {
                        pieceName: PIECE_NAME,
                        pieceVersion: PIECE_VERSION,
                        actionName: SPLIT_ACTION_NAME,
                        input,
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        const body = await response.json();
        flowVersionId = body.version.id;
        return body;
    }

    // Unsupported file format rejected
    // Non-PDF files (.xlsx, .jpg) must be rejected, not silently OCR'd
    test('Unsupported file format is rejected', async ({ request }) => {
        await updateSplitAction(request, {
            fileUrls: [{ file: fileDataUri(UNSUPPORTED_FORMAT_PATH, 'text/plain') }],
            schemaIds: { schemaIds: [schemaId] },
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('Unsupported file type(s)');
    });

    // Password-protected PDF rejected
    // Encrypted PDFs must fail cleanly, not hang or silently return empty
    test('Password-protected PDF is rejected', async ({ request }) => {
        await updateSplitAction(request, {
            fileUrls: [{ file: fileDataUri(INVOICE_PROTECTED_PATH, 'application/pdf') }],
            schemaIds: { schemaIds: [schemaId] },
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('encrypted');
    });

    // Document-by-document mode: 15-page limit enforced
    // processPageByPage:false caps single-document processing at 15 pages
    test('Document-by-document mode enforces the 15-page limit', async ({ request }) => {
        await updateSplitAction(request, {
            fileUrls: [{ file: fileDataUri(INVOICE_20PAGE_PATH, 'application/pdf') }],
            schemaIds: { schemaIds: [schemaId] },
            processPageByPage: false,
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, LARGE_RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain(
            'exceed the 15-page limit for document-by-document processing',
        );
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('20 pages');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('Enable "Process Page by Page"');
    });

    // Same 20-page document with processPageByPage:true
    // Confirms the toggle actually lifts the 15-page cap
    test('Enabling Process Page by Page lifts the 15-page limit', async ({ request }) => {
        await updateSplitAction(request, {
            fileUrls: [{ file: fileDataUri(INVOICE_20PAGE_PATH, 'application/pdf') }],
            schemaIds: { schemaIds: [schemaId] },
            processPageByPage: true,
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, LARGE_RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('SUCCEEDED');
        expect.soft(runDetail.steps?.step_1?.output?.[SCHEMA_NAME]?.length).toBe(20);
    });

    // Absolute 50-page limit enforced even with page-by-page on
    // A single 60-page document still fails regardless of the toggle
    test('A single document over the 50-page ceiling is rejected even with Process Page by Page on', async ({ request }) => {
        await updateSplitAction(request, {
            fileUrls: [{ file: fileDataUri(INVOICE_60PAGE_PATH, 'application/pdf') }],
            schemaIds: { schemaIds: [schemaId] },
            processPageByPage: true,
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, LARGE_RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain(
            'exceed the 50-page limit supported by "Split Document and OCR"',
        );
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('60 pages');
    });

    // Combined page limit across multiple documents
    // Two 30-page documents (60 total) exceed the 50-page combined limit even though neither alone does
    test('Combined page count across multiple documents enforces its own 50-page limit', async ({ request }) => {
        const thirtyPageUri = fileDataUri(INVOICE_30PAGE_PATH, 'application/pdf');
        await updateSplitAction(request, {
            fileUrls: [{ file: thirtyPageUri }, { file: thirtyPageUri }],
            schemaIds: { schemaIds: [schemaId] },
            processPageByPage: true,
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, LARGE_RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toBe(
            'The selected documents total 60 pages, which exceeds the 50-page limit "Split Document and OCR" supports combined across all documents in one run.',
        );
    });
});

test.describe('Classify Document edge cases', () => {
    test.describe.configure({ mode: 'serial', timeout: 120_000 });
    const session = loadSession();
    const auth = { Authorization: `Bearer ${session.token}` };

    let flowId: string;
    let flowVersionId: string;
    let schemaId: string;

    function fileDataUri(filePath: string, mimeType: string): string {
        return `data:${mimeType};base64,${fs.readFileSync(filePath).toString('base64')}`;
    }

    async function addClassifyAction(request: any, input: Record<string, unknown>): Promise<any> {
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'trigger',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_1',
                        valid: true,
                        displayName: 'Classify Document',
                        type: 'PIECE',
                        settings: {
                            pieceName: PIECE_NAME,
                            pieceVersion: PIECE_VERSION,
                            actionName: CLASSIFY_ACTION_NAME,
                            input,
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        const body = await response.json();
        flowVersionId = body.version.id;
        return body;
    }

    async function updateClassifyAction(request: any, input: Record<string, unknown>): Promise<any> {
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_1',
                    valid: true,
                    displayName: 'Classify Document',
                    type: 'PIECE',
                    settings: {
                        pieceName: PIECE_NAME,
                        pieceVersion: PIECE_VERSION,
                        actionName: CLASSIFY_ACTION_NAME,
                        input,
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        const body = await response.json();
        flowVersionId = body.version.id;
        return body;
    }

    // Creates the draft flow that every edge-case scenario below configures the
    // "Classify Document" step within. Deliberately doesn't add the step here
    // with empty input - that invalid-input check is already covered by
    // "Docxster OCR piece"'s own "Add Classify Document action with empty input"
    // test; the first scenario below adds step_1 directly with its real input.
    test('Create flow for Classify Document edge cases', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('flows', {
            data: {
                displayName: 'API Test - Classify Document edge cases',
                projectId: session.projectId,
            },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);
        const body = await response.json();
        flowId = body.id;
        flowVersionId = body.version.id;
    });

    // Resolve a document schema
    // Sources a real schemaId (Invoice) used as the candidate schemaIds in every scenario below
    test('Resolve a document schema for edge case scenarios', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('document/schemas', {
            params: { projectId: session.projectId },
            headers: auth,
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const invoiceSchema = body.find((s: { id: string; name: string }) => s.name === SCHEMA_NAME);
        expect.soft(invoiceSchema).toBeTruthy();
        schemaId = invoiceSchema.id;
    });

    // Classify a 60-page document
    // Confirms Classify Document has no page-count limit, unlike Split Document and OCR's 15/50-page caps
    test('Classify Document has no page-count limit, unlike Split Document and OCR', async ({ request }) => {
        await addClassifyAction(request, {
            files: fileDataUri(INVOICE_60PAGE_PATH, 'application/pdf'),
            schemaIds: { schemaIds: [schemaId] },
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, LARGE_RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('SUCCEEDED');

        const output = runDetail.steps?.step_1?.output;
        expect.soft(Array.isArray(output)).toBe(true);
        expect.soft(output?.length).toBe(60);
    });

    // Unsupported file format rejected
    // A plain text file is neither PDF nor image
    test('Unsupported file format is rejected', async ({ request }) => {
        await updateClassifyAction(request, {
            files: fileDataUri(UNSUPPORTED_FORMAT_PATH, 'text/plain'),
            schemaIds: { schemaIds: [schemaId] },
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('Unsupported file type(s)');
    });

    // Password-protected PDF rejected
    // Encrypted PDFs must fail referencing the encryption itself
    test('Password-protected PDF is rejected', async ({ request }) => {
        await updateClassifyAction(request, {
            files: fileDataUri(INVOICE_PROTECTED_PATH, 'application/pdf'),
            schemaIds: { schemaIds: [schemaId] },
        });

        const testStepResponse = await request.post('sample-data/test-step', {
            data: { flowVersionId, stepName: 'step_1' },
            headers: auth,
        });
        expect.soft(testStepResponse.status()).toBe(200);
        const testStepBody = await testStepResponse.json();

        const runDetail = await waitForRunFinished(request, auth, testStepBody.id, RUN_POLL_TIMEOUT_MS);
        expect.soft(runDetail.status).toBe('FAILED');
        expect.soft(runDetail.steps?.step_1?.errorMessage).toContain('encrypted');
    });

    // Cleanup — delete the flow
    // Removes the suite's scratch flow
    test('Delete the flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.delete(`flows/${flowId}`, { data: {}, headers: auth });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(204);
    });
});
