import { expect, request as apiRequest, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { env } from '../config';
import { loadSession } from '../session';
import {
  createSpreadsheetSchemaFixture,
  deleteSpreadsheetSchemaFixture,
} from './fixtures/SpreadsheetSchema.fixture';

async function waitForRun(api: APIRequestContext, runId: string, stepName = 'step_1') {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await api.get(`flow-runs/${runId}`);
    if (!response.ok()) {
      throw new Error(`GET flow-runs/${runId} failed: ${response.status()} ${await response.text()}`);
    }
    const run = await response.json();
    const step = run.steps?.[stepName];
    if (!['QUEUED', 'RUNNING'].includes(run.status) && step && (step.output !== undefined || step.errorMessage !== undefined)) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Flow run ${runId} did not finish within 120 seconds.`);
}

test.describe('Export to Spreadsheet API', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  const session = loadSession();
  const auth = { Authorization: `Bearer ${session.token}` };
  const apiContext = apiRequest.newContext({
    baseURL: env.apiBaseUrl,
    extraHTTPHeaders: auth,
    timeout: 120_000,
  });

  let flowId = '';
  let pieceVersion = '';
  let formsPieceVersion = '';
  let spreadsheetFixture: Awaited<ReturnType<typeof createSpreadsheetSchemaFixture>> | undefined;

  test.beforeAll(async () => {
    const api = await apiContext;

    // Flow validation requires installed piece versions; retrieve them instead of pinning constants.
    const pieceResponse = await api.get('pieces/%40docxster%2Fpiece-excel-review', { headers: auth });
    // Both installed pieces must be available before configuring this flow.
    expect(pieceResponse.status(), await pieceResponse.text()).toBe(200);
    pieceVersion = (await pieceResponse.json()).version;

    const formsResponse = await api.get('pieces/%40docxster%2Fpiece-forms', { headers: auth });
    // The Chat UI trigger uses the installed forms piece.
    expect(formsResponse.status(), await formsResponse.text()).toBe(200);
    formsPieceVersion = (await formsResponse.json()).version;

    // Create a disposable flow and add the Chat UI trigger required before inserting an action.
    const flowResponse = await api.post('flows', {
      headers: auth,
      data: {
        displayName: `API Export Spreadsheet ${Date.now()}`,
        projectId: session.projectId,
      },
    });
    // A new temporary flow should be created successfully for this suite.
    expect(flowResponse.status(), await flowResponse.text()).toBe(201);
    const flow = await flowResponse.json();
    flowId = flow.id;

    const triggerResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_TRIGGER',
        request: {
          name: 'trigger',
          valid: true,
          displayName: 'Chat UI',
          type: 'PIECE_TRIGGER',
          settings: {
            pieceName: '@docxster/piece-forms',
            pieceVersion: formsPieceVersion,
            triggerName: 'chat_submission',
            input: { botName: 'API Export Spreadsheet Test' },
            inputUiInfo: {},
          },
        },
      },
    });
    // Configure the trigger successfully before attaching the export action.
    expect(triggerResponse.status(), await triggerResponse.text()).toBe(200);

    // Add Export to Spreadsheet as step_1. Each test updates this action with its scenario input.
    const actionResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'ADD_ACTION',
        request: {
          parentStep: 'trigger',
          stepLocationRelativeToParent: 'AFTER',
          action: {
            name: 'step_1',
            valid: true,
            displayName: 'Export to Spreadsheet',
            type: 'PIECE',
            settings: {
              pieceName: '@docxster/piece-excel-review',
              pieceVersion,
              actionName: 'exportToSpreadsheet',
              input: {
                tables: [{ rows: [{ setup: true }] }],
                layout: 'sheet_per_table',
              },
              inputUiInfo: {},
            },
          },
        },
      },
    });
    // The flow should accept a valid Export to Spreadsheet action.
    expect(actionResponse.status(), await actionResponse.text()).toBe(200);
  });

  test.afterAll(async () => {
    const api = await apiContext;
    if (spreadsheetFixture) {
      await deleteSpreadsheetSchemaFixture(
        api,
        spreadsheetFixture.flowId,
        spreadsheetFixture.schemaId,
        false,
        auth,
      );
    }
    if (flowId) {
      const deleteResponse = await api.delete(`flows/${flowId}`, { headers: auth, data: {} });
      // The temporary export flow should be removed after all tests complete.
      expect(deleteResponse.status(), await deleteResponse.text()).toBe(204);
    }
    await api.dispose();
  });

  test('exports object rows to a one-sheet XLSX with default settings', async () => {
    const api = await apiContext;
    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [{ rows: [{ item: 'Cocoa Sponge', qty: 2, weight: 6 }] }],
              layout: 'sheet_per_table',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // Configuration should be accepted and leave the export action valid.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();
    expect(configuredFlow.version.trigger.nextAction.valid).toBe(true);

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    // Test-step start should return a run ID for polling.
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();

    const run = await waitForRun(api, startedRun.id);

    // Export should finish successfully and return the default filename, one Sheet1 sheet, and a download URL.
    expect(run.status, JSON.stringify(run.steps, null, 2)).toBe('SUCCEEDED');
    const output = run.steps.step_1.output;
    expect(output.fileName).toBe('export.xlsx');
    expect(output.sheetCount).toBe(1);
    expect(output.tables[0].sheetName).toBe('Sheet1');
    expect(typeof output.fileUrl).toBe('string');

    const fileResponse = await api.get(output.fileUrl, { headers: auth });
    // The generated file URL should return a downloadable XLSX workbook.
    expect(fileResponse.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from([await fileResponse.body()]));

    // The workbook should contain one sheet, a header plus one row, and preserve the input values and numeric types.
    expect(workbook.worksheets).toHaveLength(1);
    const sheet = workbook.worksheets[0];
    const headers = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    expect(new Set(headers)).toEqual(new Set(['item', 'qty', 'weight']));
    expect(sheet.actualRowCount).toBe(2);
    const column = (name: string) => headers.indexOf(name) + 1;
    const dataRow = sheet.getRow(2);
    expect(dataRow.getCell(column('item')).value).toBe('Cocoa Sponge');
    expect(dataRow.getCell(column('qty')).value).toBe(2);
    expect(dataRow.getCell(column('qty')).type).toBe(ExcelJS.ValueType.Number);
    expect(dataRow.getCell(column('weight')).value).toBe(6);
    expect(dataRow.getCell(column('weight')).type).toBe(ExcelJS.ValueType.Number);
  });

  test('exports multiple tables as separate sheets', async () => {
    const api = await apiContext;
    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [
                { sheetName: 'Invoice', rows: [{ item: 'Widget', qty: 5 }] },
                { sheetName: 'Packing List', rows: [{ box: 'B1', weight: 12 }] },
              ],
              layout: 'sheet_per_table',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // Configuration and test-step start should both be accepted by the API.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();

    const run = await waitForRun(api, startedRun.id);

    // Both tables should export successfully into separately named worksheets.
    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.step_1.output.sheetCount).toBe(2);
    const fileResponse = await api.get(run.steps.step_1.output.fileUrl, { headers: auth });
    // The returned URL should provide a workbook containing both worksheets and their respective headers.
    expect(fileResponse.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from([await fileResponse.body()]));

    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Invoice', 'Packing List']);
    expect(new Set((workbook.getWorksheet('Invoice')!.getRow(1).values as unknown[]).slice(1))).toEqual(new Set(['item', 'qty']));
    expect(new Set((workbook.getWorksheet('Packing List')!.getRow(1).values as unknown[]).slice(1))).toEqual(new Set(['box', 'weight']));
  });

  test('stacks tables into one sheet with a blank separator row', async () => {
    const api = await apiContext;
    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [
                { sheetName: 'Invoice', rows: [{ item: 'Widget', qty: 5 }] },
                { sheetName: 'Packing List', rows: [{ box: 'B1', weight: 12 }] },
              ],
              layout: 'single_sheet',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // Configure and start the single-sheet export successfully.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();

    const run = await waitForRun(api, startedRun.id);

    // Single-sheet layout should produce one "Export" worksheet with both tables separated by a blank row.
    expect(run.status).toBe('SUCCEEDED');
    expect(run.steps.step_1.output.sheetCount).toBe(1);
    const fileResponse = await api.get(run.steps.step_1.output.fileUrl, { headers: auth });
    // Download the workbook so its sheet layout and row order can be verified.
    expect(fileResponse.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from([await fileResponse.body()]));

    const rows: unknown[][] = [];
    workbook.worksheets[0].eachRow({ includeEmpty: true }, (row) => {
      rows.push((row.values as unknown[]).slice(1));
    });
    expect(workbook.worksheets[0].name).toBe('Export');
    expect(rows[0]).toEqual(['Invoice']);
    expect(new Set(rows[1])).toEqual(new Set(['item', 'qty']));
    expect(new Set(rows[2])).toEqual(new Set(['Widget', 5]));
    expect(rows[3].every((cell) => cell === undefined || cell === null)).toBe(true);
    expect(rows[4]).toEqual(['Packing List']);
    expect(new Set(rows[5])).toEqual(new Set(['box', 'weight']));
    expect(new Set(rows[6])).toEqual(new Set(['B1', 12]));
  });

  test('uses unique valid sheet names and does not duplicate the XLSX extension', async () => {
    const api = await apiContext;
    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [
                { sheetName: 'Invoice/Lines:2026 Extremely Long Descriptive Name', rows: [{ a: 1 }] },
                { sheetName: 'Dup', rows: [{ a: 2 }] },
                { sheetName: 'Dup', rows: [{ a: 3 }] },
              ],
              layout: 'sheet_per_table',
              fileName: 'Q3 Report.xlsx',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // The API should accept the custom filename and all three table configurations.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();

    const run = await waitForRun(api, startedRun.id);

    // Export should succeed with the requested filename and three unique worksheet names.
    expect(run.status).toBe('SUCCEEDED');
    const output = run.steps.step_1.output;
    expect(output.fileName).toBe('Q3 Report.xlsx');
    expect(output.fileName.match(/\.xlsx/g)).toHaveLength(1);
    expect(output.sheetCount).toBe(3);
    const fileResponse = await api.get(output.fileUrl, { headers: auth });
    // The downloaded workbook should use valid, unique Excel sheet names.
    expect(fileResponse.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from([await fileResponse.body()]));

    const [cleanedName, duplicateName, secondDuplicateName] = workbook.worksheets.map((sheet) => sheet.name);
    expect(cleanedName.length).toBeLessThanOrEqual(31);
    expect(cleanedName).not.toMatch(/[:\\/?*[\]]/);
    expect([duplicateName, secondDuplicateName]).toEqual(['Dup', 'Dup (2)']);
  });

  test('preserves a two-dimensional array as spreadsheet rows', async () => {
    const api = await apiContext;
    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [{ rows: [['SKU', 'Qty'], ['A-1', 2]] }],
              layout: 'sheet_per_table',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // Configuration and test-step start should accept the 2D-array input.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();
    const run = await waitForRun(api, startedRun.id);

    // The exported workbook should preserve the supplied array as two rows and two columns.
    expect(run.status).toBe('SUCCEEDED');
    const fileResponse = await api.get(run.steps.step_1.output.fileUrl, { headers: auth });
    // The generated XLSX should be downloadable before checking its exact cell values.
    expect(fileResponse.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from([await fileResponse.body()]));

    const sheet = workbook.worksheets[0];
    expect(sheet.actualRowCount).toBe(2);
    expect((sheet.getRow(1).values as unknown[]).slice(1)).toEqual(['SKU', 'Qty']);
    expect((sheet.getRow(2).values as unknown[]).slice(1)).toEqual(['A-1', 2]);
  });

  test('exports rows returned by Process Spreadsheet', async () => {
    const api = await apiContext;
    spreadsheetFixture = await createSpreadsheetSchemaFixture(api, session.projectId, auth);
      const csv = fs.readFileSync(path.join(__dirname, '..', 'Testdata', 'spreadsheet-review.csv'));

      const processResponse = await api.post(`flows/${spreadsheetFixture.flowId}`, {
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
              pieceVersion: spreadsheetFixture.spreadsheetPieceVersion,
              actionName: 'review_spreadsheet',
              input: {
                files: [{ file: `data:text/csv;base64,${csv.toString('base64')}` }],
                schemaId: spreadsheetFixture.schemaId,
                tableName: 'Line Items',
                headerRowNumber: 1,
                enableHumanReview: false,
              },
              inputUiInfo: {},
            },
          },
        },
      });
      // Process Spreadsheet should accept the CSV and schema configuration.
      expect(processResponse.status(), await processResponse.text()).toBe(200);

      // Run the processing action first and pass its API result into the export action.
      const processStartResponse = await api.post('sample-data/test-step', {
        headers: auth,
        data: { flowVersionId: (await processResponse.json()).version.id, stepName: 'step_1' },
      });
      // Starting the processing step should return a run that completes successfully with one mapped row.
      expect(processStartResponse.status(), await processStartResponse.text()).toBe(200);
      const processStartedRun = await processStartResponse.json();
      const processRun = await waitForRun(api, processStartedRun.id);
      expect(processRun.status).toBe('SUCCEEDED');
      const processedRows = processRun.steps.step_1.output[spreadsheetFixture.schemaName][0].tables['Line Items'].rows;
      expect(processedRows).toHaveLength(1);

      const exportResponse = await api.post(`flows/${spreadsheetFixture.flowId}`, {
        headers: auth,
        data: {
          type: 'ADD_ACTION',
          request: {
            parentStep: 'step_1',
            stepLocationRelativeToParent: 'AFTER',
            action: {
              name: 'step_2',
              valid: true,
              displayName: 'Export to Spreadsheet',
              type: 'PIECE',
              settings: {
                pieceName: '@docxster/piece-excel-review',
                pieceVersion,
                actionName: 'exportToSpreadsheet',
                input: {
                  tables: [{ rows: processedRows }],
                  layout: 'sheet_per_table',
                },
                inputUiInfo: {},
              },
            },
          },
        },
      });
      // The export action should accept the rows produced by the preceding processing run.
      expect(exportResponse.status(), await exportResponse.text()).toBe(200);
      const configuredFlow = await exportResponse.json();
      expect(configuredFlow.version.trigger.nextAction.nextAction.valid).toBe(true);

      const startResponse = await api.post('sample-data/test-step', {
        headers: auth,
        data: { flowVersionId: configuredFlow.version.id, stepName: 'step_2' },
      });
      // Start the export step and confirm it succeeds with the processed row count.
      expect(startResponse.status(), await startResponse.text()).toBe(200);
      const startedRun = await startResponse.json();
      const run = await waitForRun(api, startedRun.id, 'step_2');

      expect(run.status).toBe('SUCCEEDED');
      expect(run.steps.step_2.output.tables[0].rowCount).toBe(1);
      const fileResponse = await api.get(run.steps.step_2.output.fileUrl, { headers: auth });
      // The exported file should contain the same mapped fields and values as Process Spreadsheet output.
      expect(fileResponse.status()).toBe(200);
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.read(Readable.from([await fileResponse.body()]));

      const sheet = workbook.worksheets[0];
      expect(sheet.actualRowCount).toBe(2);
      const headers = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
      const column = (name: string) => headers.indexOf(name) + 1;
      expect(new Set(headers)).toEqual(new Set(['description', 'qty', 'unitPrice', 'total']));
      expect(sheet.getRow(2).getCell(column('description')).value).toBe('Functional Widget');
      expect(sheet.getRow(2).getCell(column('qty')).value).toBe(2);
      expect(sheet.getRow(2).getCell(column('unitPrice')).value).toBe(11);
      expect(sheet.getRow(2).getCell(column('total')).value).toBe(22);
  });

  test('rejects non-array rows with a specific error', async () => {
    const api = await apiContext;
    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [{ rows: { item: 'x' } }],
              layout: 'sheet_per_table',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // The API accepts the action configuration; input validation is expected during execution.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();
    const run = await waitForRun(api, startedRun.id);

    // A non-array Rows value should fail at the action step with the specific validation message.
    expect(run.status).toBe('FAILED');
    expect(run.steps.step_1.status).toBe('FAILED');
    expect(run.steps.step_1.errorMessage).toContain(
      'Rows for table 1 must be an array of row objects or a 2D array, received object.',
    );
  });

  test('exports 10,000 rows without truncation', async () => {
    const api = await apiContext;
    const rowCount = 10_000;
    const rows = Array.from({ length: rowCount }, (_, id) => ({
      id,
      name: `Item ${id}`,
      qty: id % 100,
      price: Number((id * 1.5).toFixed(2)),
    }));

    const configureResponse = await api.post(`flows/${flowId}`, {
      headers: auth,
      data: {
        type: 'UPDATE_ACTION',
        request: {
          name: 'step_1',
          valid: true,
          displayName: 'Export to Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion,
            actionName: 'exportToSpreadsheet',
            input: {
              tables: [{ rows }],
              layout: 'sheet_per_table',
            },
            inputUiInfo: {},
          },
        },
      },
    });
    // The action should accept the 10,000-row request payload and start the run.
    expect(configureResponse.status(), await configureResponse.text()).toBe(200);
    const configuredFlow = await configureResponse.json();

    const startResponse = await api.post('sample-data/test-step', {
      headers: auth,
      data: { flowVersionId: configuredFlow.version.id, stepName: 'step_1' },
    });
    expect(startResponse.status(), await startResponse.text()).toBe(200);
    const startedRun = await startResponse.json();
    const run = await waitForRun(api, startedRun.id);

    // Export should report all requested rows and produce a workbook with one additional header row.
    expect(run.status).toBe('SUCCEEDED');
    const output = run.steps.step_1.output;
    expect(output.tables[0].rowCount).toBe(rowCount);

    const fileResponse = await api.get(output.fileUrl, { headers: auth });
    // The output URL should return the complete large workbook.
    expect(fileResponse.status()).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from([await fileResponse.body()]));
    const sheet = workbook.worksheets[0];
    expect(sheet.actualRowCount).toBe(rowCount + 1);

    const headers = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    const column = (name: string) => headers.indexOf(name) + 1;
    // Check the first and final records to detect truncation or off-by-one row errors.
    expect(sheet.getRow(2).getCell(column('id')).value).toBe(0);
    expect(sheet.getRow(2).getCell(column('name')).value).toBe('Item 0');
    expect(sheet.getRow(rowCount + 1).getCell(column('id')).value).toBe(rowCount - 1);
    expect(sheet.getRow(rowCount + 1).getCell(column('name')).value).toBe(`Item ${rowCount - 1}`);
    expect(sheet.getRow(rowCount + 1).getCell(column('qty')).type).toBe(ExcelJS.ValueType.Number);
  });
});
