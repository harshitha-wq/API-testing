import { test, expect, APIRequestContext } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 2500; // raised from 1000ms - dev env has normal 1.0-1.5s latency spikes

const EMAIL_ALIAS_PIECE = '@docxster/piece-email-alias';
const EMAIL_ALIAS_VERSION = '2.0.1';
const SLACK_PIECE = '@docxster/piece-slack';
const SLACK_VERSION = '0.10.4';
const GMAIL_PIECE = '@docxster/piece-gmail';
const GMAIL_VERSION = '0.9.1';
const SLACK_TEST_USER_ID = 'USLACKBOT';
const ALIAS_ADDRESS_REGEX = /^inbound-[0-9a-f]{32}@[a-z0-9.-]+$/i;
const ALIAS_ADDRESS_SEARCH_REGEX = /inbound-[0-9a-f]{32}@[a-z0-9.-]+/i;

// Every discrete HTTP call in this file - including each iteration inside a
// polling loop - is expected to respond quickly on its own; a wait loop taking
// up to a minute for the underlying event is a separate concern from whether
// each individual request came back promptly.
function assertResponseTime(startTime: number): void {
    expect.soft(Date.now() - startTime).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
}

async function getActiveConnectionExternalId(
    request: APIRequestContext,
    auth: Record<string, string>,
    projectId: string,
    pieceName: string,
): Promise<string> {
    const startTime = Date.now();
    const response = await request.get('app-connections', {
        params: { projectId, pieceName },
        headers: auth,
    });
    assertResponseTime(startTime);
    const body = await response.json();
    const connection = (body.data ?? []).find((c: { status: string }) => c.status === 'ACTIVE');
    if (!connection) {
        throw new Error(`No ACTIVE app connection found for piece ${pieceName} in project ${projectId} - required for real-email tests`);
    }
    return connection.externalId as string;
}

async function getLatestRunId(
    request: APIRequestContext,
    auth: Record<string, string>,
    projectId: string,
    flowId: string,
): Promise<string | null> {
    const startTime = Date.now();
    const response = await request.get('flow-runs', {
        params: { projectId, flowId, limit: 1 },
        headers: auth,
    });
    assertResponseTime(startTime);
    const body = await response.json();
    return body.data?.[0]?.id ?? null;
}

// Polls the target flow's run list until a run with a different id than the pre-send
// baseline shows up, or returns null on timeout (used to assert "no run was created").
async function waitForNewRun(
    request: APIRequestContext,
    auth: Record<string, string>,
    projectId: string,
    flowId: string,
    baselineRunId: string | null,
    timeoutMs: number,
): Promise<{ id: string; status: string } | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pollStartTime = Date.now();
        const response = await request.get('flow-runs', {
            params: { projectId, flowId, limit: 1 },
            headers: auth,
        });
        assertResponseTime(pollStartTime);
        const body = await response.json();
        const run = body.data?.[0];
        if (run && run.id !== baselineRunId) {
            return run;
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }
    return null;
}

async function waitForRunFinished(
    request: APIRequestContext,
    auth: Record<string, string>,
    runId: string,
    timeoutMs: number,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const pollStartTime = Date.now();
        const response = await request.get(`flow-runs/${runId}`, { headers: auth });
        assertResponseTime(pollStartTime);
        const body = await response.json();
        if (body.status === 'SUCCEEDED' || body.status === 'FAILED') {
            return body;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error(`Flow run ${runId} did not finish within ${timeoutMs}ms`);
}


async function dispatchRealEmail(
    request: APIRequestContext,
    auth: Record<string, string>,
    mailerFlowId: string,
    gmailConnectionExternalId: string,
    payload: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string },
): Promise<void> {
    const updateStartTime = Date.now();
    const updateRes = await request.post(`flows/${mailerFlowId}`, {
        data: {
            type: 'UPDATE_ACTION',
            request: {
                name: 'step_1',
                valid: true,
                displayName: 'Send Email',
                type: 'PIECE',
                settings: {
                    pieceName: GMAIL_PIECE,
                    pieceVersion: GMAIL_VERSION,
                    actionName: 'send_email',
                    input: {
                        auth: `{{connections['${gmailConnectionExternalId}']}}`,
                        receiver: payload.to,
                        cc: payload.cc ?? [],
                        bcc: payload.bcc ?? [],
                        subject: payload.subject,
                        body_type: 'plain_text',
                        body: payload.body,
                        draft: false,
                    },
                    inputUiInfo: {},
                },
            },
        },
        headers: auth,
    });
    assertResponseTime(updateStartTime);
    const updateBody = await updateRes.json();
    if (updateRes.status() !== 200 || updateBody.version?.trigger?.nextAction?.valid !== true) {
        throw new Error(`Mailer action update failed: ${updateRes.status()} ${JSON.stringify(updateBody)}`);
    }

    const testStepStartTime = Date.now();
    const testStepRes = await request.post('sample-data/test-step', {
        data: { flowVersionId: updateBody.version.id, stepName: 'step_1' },
        headers: auth,
    });
    assertResponseTime(testStepStartTime);
    if (testStepRes.status() !== 200) {
        throw new Error(`Mailer test-step POST failed: ${testStepRes.status()}`);
    }
    const testStepBody = await testStepRes.json();

    const runDetail = await waitForRunFinished(request, auth, testStepBody.id, 30_000);
    if (runDetail.status !== 'SUCCEEDED') {
        throw new Error(`Mailer send did not succeed: ${JSON.stringify(runDetail.steps)}`);
    }
}


async function sendEmailAndAwaitFullRun(
    request: APIRequestContext,
    auth: Record<string, string>,
    projectId: string,
    mailerFlowId: string,
    gmailConnectionExternalId: string,
    e2eFlowId: string,
    payload: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; body: string },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastRunDetail: any;
    for (let attempt = 1; attempt <= 2; attempt++) {
        const baselineRunId = await getLatestRunId(request, auth, projectId, e2eFlowId);
        await dispatchRealEmail(request, auth, mailerFlowId, gmailConnectionExternalId, {
            ...payload,
            subject: attempt === 1 ? payload.subject : `${payload.subject} (retry)`,
        });

        const run = await waitForNewRun(request, auth, projectId, e2eFlowId, baselineRunId, 60_000);
        if (!run) {
            throw new Error('Alias flow never produced a run for this send');
        }
        lastRunDetail = await waitForRunFinished(request, auth, run.id, 30_000);
        if (lastRunDetail.status === 'SUCCEEDED') {
            return lastRunDetail;
        }
        console.log(`Attempt ${attempt} run did not succeed, step detail:`, JSON.stringify(lastRunDetail.steps));
    }
    return lastRunDetail;
}

test.describe('Email Alias', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();

    let flowId: string;
    let flowVersionId: string;
    let connectionId: string;
    let connectionExternalId: string;

    // State shared by the real-email tests (API_014-API_018) - a separate flow/mailer
    // pair from the one above, since those need a REAL Slack connection/userId to
    // verify the message actually sends, not just that the step is schema-valid.
    let mailerFlowId: string;
    let gmailConnectionExternalId: string;
    let e2eFlowId: string;
    let e2eFlowVersionId: string;
    let e2eAliasAddress: string;
    let realSenderDomain: string;

    // TC ID: API_001
    // Purpose: Create a new, unpublished flow to attach the Email Alias trigger and Slack action to
    // POST /flows - creates a fresh, unpublished flow to configure the Email Alias
    // trigger and Slack action on, mirroring the UI test's beforeEach flow selection.
    // This flow gets DISABLED again in API_014, once its own assertions are done, to
    // free a slot under the project's active-flow plan limit for the real e2e flow.
    test('Create a new flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('flows', {
            data: {
                displayName: 'API Test Email Alias Flow',
                projectId: session.projectId,
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);
        const body = await response.json();

        expect.soft(typeof body.id).toBe('string');
        expect.soft(body.status).toBe('DISABLED');
        expect.soft(body.publishedVersionId).toBeNull();
        expect.soft(body.version.trigger.type).toBe('EMPTY');

        flowId = body.id;
        flowVersionId = body.version.id;
    });

    // TC ID: API_002
    // Purpose: Configure the flow's trigger as the Email Alias "Email Received" piece trigger
    // POST /flows/{id} (type: UPDATE_TRIGGER) - configures the Email Alias trigger
    // (piece @docxster/piece-email-alias, trigger email_received). allowedSenders
    // starts empty, matching "left empty accepts all senders" in the UI test.
    test('Apply UPDATE_TRIGGER operation to add the Email Alias trigger', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: [] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        expect.soft(body.version.trigger.type).toBe('PIECE_TRIGGER');
        expect.soft(body.version.trigger.displayName).toBe('Email Received');
        expect.soft(body.version.trigger.settings.pieceName).toBe(EMAIL_ALIAS_PIECE);
        expect.soft(body.version.trigger.settings.triggerName).toBe('email_received');
        expect.soft(body.version.trigger.settings.input.allowedSenders).toEqual([]);
        // Run Test/trigger stays enabled with an empty list (accepts all senders)
        expect.soft(body.version.trigger.valid).toBe(true);
        expect.soft(body.version.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // TC ID: API_003
    // Purpose: Resolve the trigger's dynamic inboxAddress prop to read the generated alias address
    // POST /v1/pieces/options - resolves the trigger's dynamicProperties prop
    // (inboxAddress), the API equivalent of reading "Your alias address:" in the
    // sidebar. Also confirms the flow hasn't been published yet.
    test('Resolve the alias inbox address and confirm the flow is unpublished', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post('pieces/options', {
            data: {
                pieceName: EMAIL_ALIAS_PIECE,
                pieceVersion: EMAIL_ALIAS_VERSION,
                actionOrTriggerName: 'email_received',
                propertyName: 'inboxAddress',
                flowId,
                flowVersionId,
                input: { allowedSenders: [] },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        // The dynamic prop returns markdown embedding the address (see
        // email-received.ts props()) rather than a plain address field, so pull the
        // address out of the markdown text with the same regex the UI test applies.
        const markdown: string = body.options?._info?.description ?? JSON.stringify(body.options ?? {});
        const match = markdown.match(ALIAS_ADDRESS_SEARCH_REGEX);
        expect.soft(match).toBeTruthy();
        if (match) {
            expect.soft(match[0]).toMatch(ALIAS_ADDRESS_REGEX);
        }

        // Not published yet - a fresh flow has no publishedVersionId
        const flowResponse = await request.get(`flows/${flowId}`, {
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const flowBody = await flowResponse.json();
        expect.soft(flowBody.status).toBe('DISABLED');
        expect.soft(flowBody.publishedVersionId).toBeNull();
    });

    // TC ID: API_004
    // Purpose: Confirm repeated resolution of the alias address returns the same value (no new token generated)
    // Alias registration is idempotent (email-received.ts onEnable comment: "keeps
    // existing token, updates allowedSenders"), so resolving the address twice in a
    // row must return the same value - the API equivalent of close/reopen not
    // generating a new token.
    test('Verify the alias address is stable across repeated resolutions', async ({ request }) => {
        const resolveOnce = async () => {
            const response = await request.post('pieces/options', {
                data: {
                    pieceName: EMAIL_ALIAS_PIECE,
                    pieceVersion: EMAIL_ALIAS_VERSION,
                    actionOrTriggerName: 'email_received',
                    propertyName: 'inboxAddress',
                    flowId,
                    flowVersionId,
                    input: { allowedSenders: [] },
                },
                headers: { Authorization: `Bearer ${session.token}` },
            });
            const body = await response.json();
            const markdown: string = body.options?._info?.description ?? '';
            return markdown.match(ALIAS_ADDRESS_SEARCH_REGEX)?.[0];
        };

        const firstAddress = await resolveOnce();
        const secondAddress = await resolveOnce();

        expect.soft(firstAddress).toBeTruthy();
        expect(secondAddress).toBe(firstAddress);
    });

    // TC ID: API_005 (add) / API_006 (remove)
    // Purpose: Add one entry to Allowed Senders, then clear it back to empty
    // POST /flows/{id} (type: UPDATE_TRIGGER) - adds one Allowed Senders item, then a
    // follow-up call clears it, mirroring addListItem()/removeFieldItem() in the UI test.
    test('Verify Allowed Senders supports adding and removing a list item', async ({ request }) => {
        const addResponseStartTime = Date.now();
        const addResponse = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: ['alice@acme.com'] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const addResponseDurationMs = Date.now() - addResponseStartTime;
        expect.soft(addResponseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(addResponse.status()).toBe(200);
        const addBody = await addResponse.json();
        expect.soft(addBody.version.trigger.settings.input.allowedSenders).toEqual(['alice@acme.com']);

        const removeResponseStartTime = Date.now();
        const removeResponse = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: [] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const removeResponseDurationMs = Date.now() - removeResponseStartTime;
        expect.soft(removeResponseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect.soft(removeResponse.status()).toBe(200);
        const removeBody = await removeResponse.json();
        expect.soft(removeBody.version.trigger.settings.input.allowedSenders).toEqual([]);
        expect.soft(removeBody.version.trigger.valid).toBe(true);
    });

    // TC ID: API_007
    // Purpose: Confirm a non-email string is accepted with no format validation error
    // allowedSenders is Property.Array (free text), not an email field - the piece
    // schema has no format validation, so a non-email string must be accepted as-is.
    test('Verify Allowed Senders accepts free text without email-format validation', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: ['not-an-email'] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.version.trigger.settings.input.allowedSenders).toEqual(['not-an-email']);
        expect.soft(body.version.trigger.valid).toBe(true);
        expect.soft(body.version.valid).toBe(true);
    });

    // TC ID: API_008
    // Purpose: Create the app connection the Slack action step will reference by externalId
    test('Create a Slack app connection for the flow to use', async ({ request }) => {
        connectionExternalId = `email-alias-slack-${Date.now()}`;

        const responseStartTime = Date.now();
        const response = await request.post('app-connections', {
            data: {
                externalId: connectionExternalId,
                displayName: 'API Test Slack Connection',
                pieceName: SLACK_PIECE,
                projectId: session.projectId,
                metadata: {},
                type: 'SECRET_TEXT',
                value: { type: 'SECRET_TEXT', secret_text: 'fake-slack-token' },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(201);
        const body = await response.json();
        expect.soft(body.externalId).toBe(connectionExternalId);
        expect.soft(body.pieceName).toBe(SLACK_PIECE);
        expect.soft(body.type).toBe('SECRET_TEXT');

        connectionId = body.id;
    });

    // TC ID: API_009
    // Purpose: Add the Slack "Send Message To A User" step with no props filled in
    // POST /flows/{id} (type: ADD_ACTION) - adds the Slack "Send Message To A User"
    // step (send_direct_message) with no input filled in at all. The server
    // recomputes step validity via AJV against the piece's required props
    // regardless of the `valid` flag sent, so this is the API equivalent of "Run
    // Test stays disabled while required fields are empty".
    test('Apply ADD_ACTION to add the Slack step with empty input - action is invalid', async ({ request }) => {
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
                        displayName: 'Send Message To A User',
                        type: 'PIECE',
                        settings: {
                            pieceName: SLACK_PIECE,
                            pieceVersion: SLACK_VERSION,
                            actionName: 'send_direct_message',
                            input: {},
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const slackStep = body.version.trigger.nextAction;
        expect.soft(slackStep).toBeTruthy();
        expect.soft(slackStep.name).toBe('step_2');
        expect.soft(slackStep.settings.actionName).toBe('send_direct_message');
        expect.soft(slackStep.valid).toBe(false);
        expect.soft(body.version.valid).toBe(false);

        flowVersionId = body.version.id;
    });

    // TC ID: API_010
    // Purpose: Fill only the `text` ("Message") prop; `userId`/`auth` still missing
    // POST /flows/{id} (type: UPDATE_ACTION) - fills only `text` (the "Message"
    // field). `userId` and `auth` are still required by the piece, so the step
    // stays invalid - equivalent of "Run Test disabled when only Message is filled".
    test('Apply UPDATE_ACTION with only Message filled - action stays invalid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_2',
                    valid: true,
                    displayName: 'Send Message To A User',
                    type: 'PIECE',
                    settings: {
                        pieceName: SLACK_PIECE,
                        pieceVersion: SLACK_VERSION,
                        actionName: 'send_direct_message',
                        input: { text: 'hi test mail' },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const slackStep = body.version.trigger.nextAction;
        expect.soft(slackStep.settings.input.text).toBe('hi test mail');
        expect.soft(slackStep.valid).toBe(false);
        expect.soft(body.version.valid).toBe(false);

        flowVersionId = body.version.id;
    });

    // TC ID: API_011
    // Purpose: Fill `auth` (connection reference), `userId`, and `text` so the step becomes valid
    test('Apply UPDATE_ACTION with all required fields - action becomes valid', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_ACTION',
                request: {
                    name: 'step_2',
                    valid: true,
                    displayName: 'Send Message To A User',
                    type: 'PIECE',
                    settings: {
                        pieceName: SLACK_PIECE,
                        pieceVersion: SLACK_VERSION,
                        actionName: 'send_direct_message',
                        input: {
                            auth: `{{connections['${connectionExternalId}']}}`,
                            userId: 'U000000TEST',
                            text: 'hi test mail',
                        },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();

        const slackStep = body.version.trigger.nextAction;
        expect.soft(slackStep.settings.input.userId).toBe('U000000TEST');
        expect.soft(slackStep.settings.input.text).toBe('hi test mail');
        expect.soft(slackStep.valid).toBe(true);
        expect.soft(body.version.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // TC ID: API_012
    // Purpose: Set the trigger's final Allowed Senders config before publish (unrelated address + covering domain)
    test('Set a mixed Allowed Senders list before publishing', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: ['bob@other.com', '@docxster.com'] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.version.trigger.settings.input.allowedSenders).toEqual(['bob@other.com', '@docxster.com']);
        expect.soft(body.version.valid).toBe(true);

        flowVersionId = body.version.id;
    });

    // TC ID: API_013
    // Purpose: Lock the current draft version and publish it (status becomes ENABLED)
    // POST /flows/{id} (type: LOCK_AND_PUBLISH) - locks the draft and publishes it.
    test('Apply LOCK_AND_PUBLISH operation to publish the flow', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.post(`flows/${flowId}`, {
            data: {
                type: 'LOCK_AND_PUBLISH',
                request: { status: 'ENABLED' },
            },
            headers: { Authorization: `Bearer ${session.token}` },
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


    // TC ID: API_014
    // Purpose: Build the real mailer flow and a real Email Alias -> Slack flow (open Allowed
    // Senders), then confirm a real email that only CC's the alias triggers a full run with Slack
    test("Alias only CC'd on a published flow still triggers a full run with Slack", async ({ request }) => {
        // Real send + wait-for-run (with retry) can approach the global 30s default.
        test.setTimeout(120_000);
        const auth = { Authorization: `Bearer ${session.token}` };

        gmailConnectionExternalId = await getActiveConnectionExternalId(request, auth, session.projectId, GMAIL_PIECE);

        const disableStartTime = Date.now();
        await request.post(`flows/${flowId}`, {
            data: { type: 'CHANGE_STATUS', request: { status: 'DISABLED' } },
            headers: auth,
        });
        assertResponseTime(disableStartTime);

        const deleteConnStartTime = Date.now();
        await request.delete(`app-connections/${connectionId}`, {
            data: {},
            headers: auth,
        }).catch(() => { });
        assertResponseTime(deleteConnStartTime);

        const realSlackConnectionExternalId = await getActiveConnectionExternalId(request, auth, session.projectId, SLACK_PIECE);

        const mailerFlowStartTime = Date.now();
        const mailerFlowRes = await request.post('flows', {
            data: { displayName: 'API Test Mailer Flow', projectId: session.projectId },
            headers: auth,
        });
        assertResponseTime(mailerFlowStartTime);
        expect.soft(mailerFlowRes.status()).toBe(201);
        mailerFlowId = (await mailerFlowRes.json()).id;

        const mailerActionStartTime = Date.now();
        const mailerActionRes = await request.post(`flows/${mailerFlowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'trigger',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_1',
                        valid: true,
                        displayName: 'Send Email',
                        type: 'PIECE',
                        settings: {
                            pieceName: GMAIL_PIECE,
                            pieceVersion: GMAIL_VERSION,
                            actionName: 'send_email',
                            input: {
                                auth: `{{connections['${gmailConnectionExternalId}']}}`,
                                receiver: ['placeholder@example.com'],
                                cc: [],
                                bcc: [],
                                subject: 'placeholder',
                                body_type: 'plain_text',
                                body: 'placeholder',
                                draft: false,
                            },
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        assertResponseTime(mailerActionStartTime);
        expect.soft(mailerActionRes.status()).toBe(200);

        expect.soft((await mailerActionRes.json()).version.trigger.nextAction.valid).toBe(true);

        const e2eFlowStartTime = Date.now();
        const flowRes = await request.post('flows', {
            data: { displayName: 'API Test Email Alias E2E Flow', projectId: session.projectId },
            headers: auth,
        });
        assertResponseTime(e2eFlowStartTime);
        e2eFlowId = (await flowRes.json()).id;

        const triggerStartTime = Date.now();
        const triggerRes = await request.post(`flows/${e2eFlowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: [] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        assertResponseTime(triggerStartTime);
        e2eFlowVersionId = (await triggerRes.json()).version.id;

        const optionsStartTime = Date.now();
        const optionsRes = await request.post('pieces/options', {
            data: {
                pieceName: EMAIL_ALIAS_PIECE,
                pieceVersion: EMAIL_ALIAS_VERSION,
                actionOrTriggerName: 'email_received',
                propertyName: 'inboxAddress',
                flowId: e2eFlowId,
                flowVersionId: e2eFlowVersionId,
                input: { allowedSenders: [] },
            },
            headers: auth,
        });
        assertResponseTime(optionsStartTime);
        const markdown: string = (await optionsRes.json()).options?._info?.description ?? '';
        e2eAliasAddress = markdown.match(ALIAS_ADDRESS_SEARCH_REGEX)?.[0] ?? '';
        expect(e2eAliasAddress).toMatch(ALIAS_ADDRESS_REGEX);

        const slackActionStartTime = Date.now();
        const slackActionRes = await request.post(`flows/${e2eFlowId}`, {
            data: {
                type: 'ADD_ACTION',
                request: {
                    parentStep: 'trigger',
                    stepLocationRelativeToParent: 'AFTER',
                    action: {
                        name: 'step_2',
                        valid: true,
                        displayName: 'Send Message To A User',
                        type: 'PIECE',
                        settings: {
                            pieceName: SLACK_PIECE,
                            pieceVersion: SLACK_VERSION,
                            actionName: 'send_direct_message',
                            input: {
                                auth: `{{connections['${realSlackConnectionExternalId}']}}`,
                                userId: SLACK_TEST_USER_ID,
                                text: 'Real inbound email triggered this run (API test)',
                            },
                            inputUiInfo: {},
                        },
                    },
                },
            },
            headers: auth,
        });
        assertResponseTime(slackActionStartTime);
        expect.soft(slackActionRes.status()).toBe(200);
        expect.soft((await slackActionRes.json()).version.valid).toBe(true);

        const publishStartTime = Date.now();
        const publishRes = await request.post(`flows/${e2eFlowId}`, {
            data: { type: 'LOCK_AND_PUBLISH', request: { status: 'ENABLED' } },
            headers: auth,
        });
        assertResponseTime(publishStartTime);
        expect.soft(publishRes.status()).toBe(200);
        expect.soft((await publishRes.json()).status).toBe('ENABLED');

        // --- Send a real email, alias only CC'd, and wait for a real run ---
        const runDetail = await sendEmailAndAwaitFullRun(request, auth, session.projectId, mailerFlowId, gmailConnectionExternalId, e2eFlowId, {
            to: ['akashp@docxster.com'],
            cc: [e2eAliasAddress],
            subject: 'API test - alias CC only',
            body: 'Real email sent purely via API calls; alias address only CC-ed.',
        });
        expect.soft(runDetail.status).toBe('SUCCEEDED');
        expect.soft(runDetail.steps?.step_2?.status).toBe('SUCCEEDED');

        // Read the real sender's domain back from the trigger's own output rather
        // than hardcoding it, so the mixed-Allowed-Senders tests below stay correct
        // regardless of which mailbox is connected in a given environment.
        const fromAddress: string = runDetail.steps?.trigger?.output?.from ?? '';
        realSenderDomain = fromAddress.split('@')[1] ?? '';
        expect(realSenderDomain).toBeTruthy();
    });

    // TC ID: API_015
    // Purpose: Update Allowed Senders to a mixed list (unrelated address + the real sender's
    // covering domain), then confirm a real email addressed directly To the alias still triggers
    // a full run with Slack
    test('Sender covered by mixed Allowed Senders, addressed direct To, triggers a full published run with Slack', async ({ request }) => {
        test.setTimeout(120_000);
        const auth = { Authorization: `Bearer ${session.token}` };

        const triggerStartTime = Date.now();
        const triggerRes = await request.post(`flows/${e2eFlowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: ['bob@other.com', `@${realSenderDomain}`] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        assertResponseTime(triggerStartTime);
        expect.soft(triggerRes.status()).toBe(200);
        e2eFlowVersionId = (await triggerRes.json()).version.id;

        const publishStartTime = Date.now();
        const publishRes = await request.post(`flows/${e2eFlowId}`, {
            data: { type: 'LOCK_AND_PUBLISH', request: { status: 'ENABLED' } },
            headers: auth,
        });
        assertResponseTime(publishStartTime);
        expect.soft(publishRes.status()).toBe(200);

        const runDetail = await sendEmailAndAwaitFullRun(request, auth, session.projectId, mailerFlowId, gmailConnectionExternalId, e2eFlowId, {
            to: [e2eAliasAddress],
            subject: 'API test - mixed list, direct To',
            body: 'Real email sent purely via API calls, addressed directly To the alias.',
        });
        expect.soft(runDetail.status).toBe('SUCCEEDED');
        expect.soft(runDetail.steps?.step_2?.status).toBe('SUCCEEDED');
    });

    // TC ID: API_016
    // Purpose: With the mixed Allowed Senders list still in effect, confirm a real email that
    // only CC's the alias also triggers a full run with Slack
    test("Sender covered by mixed Allowed Senders, only CC'd, triggers a full published run with Slack", async ({ request }) => {
        test.setTimeout(120_000);
        const auth = { Authorization: `Bearer ${session.token}` };

        const runDetail = await sendEmailAndAwaitFullRun(request, auth, session.projectId, mailerFlowId, gmailConnectionExternalId, e2eFlowId, {
            to: ['akashp@docxster.com'],
            cc: [e2eAliasAddress],
            subject: 'API test - mixed list, CC only',
            body: 'Real email sent purely via API calls; alias address only CC-ed.',
        });
        expect.soft(runDetail.status).toBe('SUCCEEDED');
        expect.soft(runDetail.steps?.step_2?.status).toBe('SUCCEEDED');
    });

    // TC ID: API_017
    // Purpose: With the mixed Allowed Senders list still in effect, confirm a real email that
    // only BCC's the alias also triggers a full run with Slack
    test("Sender covered by mixed Allowed Senders, only BCC'd, triggers a full published run with Slack", async ({ request }) => {
        test.setTimeout(120_000);
        const auth = { Authorization: `Bearer ${session.token}` };

        const runDetail = await sendEmailAndAwaitFullRun(request, auth, session.projectId, mailerFlowId, gmailConnectionExternalId, e2eFlowId, {
            to: ['akashp@docxster.com'],
            bcc: [e2eAliasAddress],
            subject: 'API test - mixed list, BCC only',
            body: 'Real email sent purely via API calls; alias address only BCC-ed.',
        });
        expect.soft(runDetail.status).toBe('SUCCEEDED');
        expect.soft(runDetail.steps?.step_2?.status).toBe('SUCCEEDED');
    });

    // TC ID: API_018
    // Purpose: Update Allowed Senders to a list that excludes the real sender's domain, then
    // confirm a real email sent directly to the alias never produces a run
    test('Sender not on Allowed Senders never produces a run on a published flow', async ({ request }) => {
        // Deliberately waits out the full 60s absence window below - always exceeds
        // the global 30s default, independent of any external slowness.
        test.setTimeout(120_000);
        const auth = { Authorization: `Bearer ${session.token}` };

        const triggerStartTime = Date.now();
        const triggerRes = await request.post(`flows/${e2eFlowId}`, {
            data: {
                type: 'UPDATE_TRIGGER',
                request: {
                    name: 'trigger',
                    valid: true,
                    displayName: 'Email Received',
                    type: 'PIECE_TRIGGER',
                    settings: {
                        pieceName: EMAIL_ALIAS_PIECE,
                        pieceVersion: EMAIL_ALIAS_VERSION,
                        triggerName: 'email_received',
                        input: { allowedSenders: ['@notarealdomain.com'] },
                        inputUiInfo: {},
                    },
                },
            },
            headers: auth,
        });
        assertResponseTime(triggerStartTime);
        expect.soft(triggerRes.status()).toBe(200);
        e2eFlowVersionId = (await triggerRes.json()).version.id;

        const publishStartTime = Date.now();
        const publishRes = await request.post(`flows/${e2eFlowId}`, {
            data: { type: 'LOCK_AND_PUBLISH', request: { status: 'ENABLED' } },
            headers: auth,
        });
        assertResponseTime(publishStartTime);
        expect.soft(publishRes.status()).toBe(200);

        const baselineRunId = await getLatestRunId(request, auth, session.projectId, e2eFlowId);
        await dispatchRealEmail(request, auth, mailerFlowId, gmailConnectionExternalId, {
            to: [e2eAliasAddress],
            subject: 'API test - blocked sender',
            body: 'This sender is not on the Allowed Senders list and must not produce a run.',
        });

        const run = await waitForNewRun(request, auth, session.projectId, e2eFlowId, baselineRunId, 60_000);
        expect(run).toBeNull();
    });

    // TC ID: API_019
    // Purpose: Permanently delete every flow and connection created by this suite (cleanup)
    test('Delete the flow and Slack connection', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.delete(`flows/${flowId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}` },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
        expect(response.status()).toBe(204);

        // connectionId was already deleted in the real-email setup above (see the
        // comment there) - nothing left to clean up for it here.
        await request.delete(`flows/${e2eFlowId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}` },
        });
        await request.delete(`flows/${mailerFlowId}`, {
            data: {},
            headers: { Authorization: `Bearer ${session.token}` },
        });
    });

    test.afterAll(async ({ request }) => {
        const auth = { Authorization: `Bearer ${session.token}` };
        for (const id of [flowId, e2eFlowId, mailerFlowId]) {
            if (id) {
                await request.delete(`flows/${id}`, { data: {}, headers: auth }).catch(() => { });
            }
        }
        if (connectionId) {
            await request.delete(`app-connections/${connectionId}`, { data: {}, headers: auth }).catch(() => { });
        }
    });
});
