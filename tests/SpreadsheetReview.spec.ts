import { test, expect, request as apiRequest } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { env } from '../config';
import { loadSession } from '../session';
import {
  createSpreadsheetSchemaFixture,
  deleteSpreadsheetSchemaFixture,
} from './fixtures/SpreadsheetSchema.fixture';

const TESTDATA_PATH = path.join(__dirname, '..', 'Testdata');
test.describe('Spreadsheet Review API', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  // Reuse the authenticated project session created by the framework's global setup.
  const session = loadSession();
  const auth = { Authorization: `Bearer ${session.token}` };

  // Share one request context and disposable schema/flow across the API test cases.
  const apiContext = apiRequest.newContext({
    baseURL: env.apiBaseUrl,
    extraHTTPHeaders: {},
    timeout: 90_000,
  });
  let spreadsheetFixture = { schemaId: '', schemaName: '', flowId: '', spreadsheetPieceVersion: '' };
  let schemaId = '';
  let schemaName = '';
  let flowId = '';
  let spreadsheetPieceVersion = '';
  let schemaDeleted = false;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const api = await apiContext;
    // Create and publish a schema with the table needed by the Process Spreadsheet action.
    spreadsheetFixture = await createSpreadsheetSchemaFixture(api, session.projectId, auth);
    schemaId = spreadsheetFixture.schemaId;
    schemaName = spreadsheetFixture.schemaName;
    flowId = spreadsheetFixture.flowId;
    spreadsheetPieceVersion = spreadsheetFixture.spreadsheetPieceVersion;
  });

  test.afterAll(async () => {
    const api = await apiContext;
    // Delete the temporary flow and schema after all scenarios have completed.
    await deleteSpreadsheetSchemaFixture(
      api,
      spreadsheetFixture.flowId,
      spreadsheetFixture.schemaId,
      schemaDeleted,
      auth,
    );
    await api.dispose();
  });

  test('Confirm CSV data maps to the published schema and creates a pending review instance', async () => {
    const api = await apiContext;
    // Configure Process Spreadsheet with the valid CSV fixture and published destination table.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();

    // Run only step_1 and retain the run ID returned by the API.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll until the run reaches a terminal state and the action output/error is persisted.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) {
        throw new Error(`GET flow-runs/${startedRun.id} failed: ${runResponse.status()} ${await runResponse.text()}`);
      }
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // Human review pauses a successful run and returns the parsed row in a pending instance.
    expect(run.status).toBe('PAUSED');
    expect(run.steps.step_1.status).toBe('PAUSED');
    const instances = run.steps.step_1.output[schemaName];
    expect(instances).toHaveLength(1);
    expect(instances[0].status).toBe('pending');
    expect(instances[0].tables['Line Items'].rows).toHaveLength(1);
    expect(instances[0].tables['Line Items'].rows[0]).toMatchObject({
      description: 'Functional Widget',
      qty: 2,
      unitPrice: 11,
      total: 22,
    });
  });

  test('Verify disabling human review processes the CSV without pausing the run', async () => {
    const api = await apiContext;
    // Configure the same valid CSV input with human review explicitly disabled.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: false,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();

    // Start the configured action; with review disabled, it should finish rather than pause.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll until the run completes and the action output is available.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) {
        throw new Error(`GET flow-runs/${startedRun.id} failed: ${runResponse.status()} ${await runResponse.text()}`);
      }
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // Verify processing succeeds without a manual-review pause and preserves the parsed row.
    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.step_1.status).toBe('SUCCEEDED');
    const instances = run.steps.step_1.output[schemaName];
    expect(instances).toHaveLength(1);
    expect(instances[0].tables['Line Items'].rows).toHaveLength(1);
    expect(instances[0].tables['Line Items'].rows[0]).toMatchObject({
      description: 'Functional Widget',
      qty: 2,
      unitPrice: 11,
      total: 22,
    });
  });

  test('Verify that each CSV file in the input array contributes a review instance', async () => {
    const api = await apiContext;
    // Supply two file fixtures in one action configuration to test per-file instance creation.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [
                {
                  file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review.csv')).toString('base64')}`,
                },
                {
                  file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review-second-file.csv')).toString('base64')}`,
                },
              ],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Start the configured step and save its run ID for polling.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Wait for both files to finish processing before checking the returned instances.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // Confirm that the two source files produced separate mapped review instances.
    expect(run.status).toBe('PAUSED');
    const instances = run.steps.step_1.output[schemaName];
    expect(instances).toHaveLength(2);
    expect(instances[0].tables['Line Items'].rows[0].description).toBe('Functional Widget');
    expect(instances[1].tables['Line Items'].rows[0].description).toBe('Second File Widget');
  });

  test('Verify headers below a title row are detected when no override is configured', async () => {
    const api = await apiContext;
    // Use the title-row fixture and omit headerRowNumber to exercise automatic detection.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review-title-row.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Start the step with this version of the configured flow.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll until the detected-header mapping is available in the run output.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // Verify the data row was mapped using the detected header row.
    const rows = run.steps.step_1.output[schemaName][0].tables['Line Items'].rows;
    expect(run.status).toBe('PAUSED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: 'Header Detection Widget',
      qty: 1,
      unitPrice: 8,
      total: 8,
    });
  });

  test('Verify a spreadsheet with no matching schema headers does not fail the run', async () => {
    const api = await apiContext;
    // Configure an input whose headers do not correspond to any destination-table columns.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review-unmatched-headers.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Execute the action to observe whether unmatched columns cause a workflow failure.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll until the run result is ready for validation.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    // The run should pause for review and produce no rows for the unmatched headers.
    expect(run.status).toBe('PAUSED');
    expect(run.steps.step_1.output[schemaName][0].tables['Line Items'].rows ?? []).toHaveLength(0);
  });

  test('Verify a data-like row without a recognized header does not fail the run', async () => {
    const api = await apiContext;
    // Configure the single-row fixture without a header-row override.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review-no-headers.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Start processing the headerless CSV fixture.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Wait for completion, then ensure the file is handled without mapped data rows.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    expect(run.status).toBe('PAUSED');
    expect(run.steps.step_1.output[schemaName][0].tables['Line Items'].rows ?? []).toHaveLength(0);
  });

  test('Pass the first run reviewSessionId into a second run and verify session reuse', async () => {
    const api = await apiContext;
    // Configure and run the first CSV to obtain a reviewSessionId from its output.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Start the first run; its run ID is used to retrieve the generated session.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll the first run until it returns the review session identifier.
    let firstRun;
    const firstDeadline = Date.now() + 60_000;
    while (Date.now() < firstDeadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      firstRun = await runResponse.json();
      const step = firstRun.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(firstRun.status) && step && step.output !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    const reviewSessionId = firstRun.steps.step_1.output.reviewSessionId;
    expect(typeof reviewSessionId).toBe('string');

    // Reconfigure the action with the first run's session ID and submit the same CSV again.
    const secondActionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
              reviewSessionId,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(secondActionResponse.status()).toBe(200);
    const secondAction = await secondActionResponse.json();
    // Start the second run so its output can confirm reuse of the existing session.
    const secondStartResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: secondAction.version.id, stepName: 'step_1' },
    });
    expect(secondStartResponse.status()).toBe(200);
    const secondStartedRun = await secondStartResponse.json();

    // Poll the second run, then compare its returned session and instance count to the first.
    let secondRun;
    const secondDeadline = Date.now() + 60_000;
    while (Date.now() < secondDeadline) {
      const runResponse = await api.get(`flow-runs/${secondStartedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      secondRun = await runResponse.json();
      const step = secondRun.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(secondRun.status) && step && step.output !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    expect(secondRun.status).toBe('PAUSED');
    expect(secondRun.steps.step_1.output.reviewSessionId).toBe(reviewSessionId);
    expect(secondRun.steps.step_1.output[schemaName].length).toBeGreaterThan(firstRun.steps.step_1.output[schemaName].length);
  });

  test('Verify configured row 2 is used as the header row instead of the title row', async () => {
    const api = await apiContext;
    // Configure row 2 explicitly as the header, skipping the first title row in the fixture.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review-header-override.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 2,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Execute the configured action using the returned flow version.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Wait for the mapped rows and check values from the selected header row.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step && step.output !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    const rows = run.steps.step_1.output[schemaName][0].tables['Line Items'].rows;
    expect(run.status).toBe('PAUSED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      description: 'Header Override Widget',
      qty: 2,
      unitPrice: 6,
      total: 12,
    });
  });

  test('Verify unsupported plain-text input fails with a format-specific error', async () => {
    const api = await apiContext;
    // Configure the action with a plain-text fixture rather than a supported spreadsheet.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/plain;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review-unsupported.txt')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Start the test step to verify that the action rejects the unsupported format.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll until the failed step and its validation message are available.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step?.errorMessage !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    expect(run.status).toBe('FAILED');
    expect(run.steps.step_1.status).toBe('FAILED');
    expect(run.steps.step_1.errorMessage).toContain('is not a recognized spreadsheet');
  });

  test('Verify execution fails after deleting the schema configured in the action', async () => {
    const api = await apiContext;
    // First configure the action with a valid file and schema while both are available.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {
              files: [{
                file: `data:text/csv;base64,${fs.readFileSync(path.join(TESTDATA_PATH, 'spreadsheet-review.csv')).toString('base64')}`,
              }],
              schemaId,
              tableName: 'Line Items',
              headerRowNumber: 1,
              enableHumanReview: true,
            },
            inputUiInfo: {},
          },
        },
      },
    });
    expect(actionResponse.status()).toBe(200);
    const action = await actionResponse.json();
    // Delete the schema before starting the saved action version.
    const deleteResponse = await api.delete(`document/schemas/${schemaId}`, { headers: auth, data: {} });
    expect([200, 202]).toContain(deleteResponse.status());
    schemaDeleted = true;

    // Start the action after deletion so its schema lookup fails during execution.
    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: action.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status()).toBe(200);
    const startedRun = await startResponse.json();

    // Poll for the expected failure and verify no successful output was produced.
    let run;
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const runResponse = await api.get(`flow-runs/${startedRun.id}`, { headers: auth });
      if (!runResponse.ok()) throw new Error(await runResponse.text());
      run = await runResponse.json();
      const step = run.steps?.step_1;
      if (!['QUEUED', 'RUNNING'].includes(run.status) && step?.errorMessage !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }

    expect(run.status).toBe('FAILED');
    expect(run.steps.step_1.status).toBe('FAILED');
    expect(run.steps.step_1.errorMessage.toLowerCase()).toContain('document type was not found');
    expect(run.steps.step_1.output).toBeUndefined();
  });
});
