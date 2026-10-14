import * as fs from 'fs';
import * as path from 'path';
import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

const TESTDATA_PATH = path.join(__dirname, '..', '..', 'Testdata');

export async function createSpreadsheetSchemaFixture(
  api: APIRequestContext,
  projectId: string,
  auth: Record<string, string>,
) {
  // Upload the template that will be turned into a disposable document schema.
  const uploadResponse = await api.post('document/schemas/batch-upload', {
    headers: auth,
    multipart: {
      projectId,
      'file-0': {
        name: 'Electronic-Purchase-Order-Template-TemplateLab.com.jpg',
        mimeType: 'image/jpeg',
        buffer: fs.readFileSync(path.join(TESTDATA_PATH, 'Electronic-Purchase-Order-Template-TemplateLab.com.jpg')),
      },
    },
  });
  const upload = await uploadResponse.json();
  expect(uploadResponse.status(), JSON.stringify(upload)).toBe(200);
  expect(typeof upload.uploadBatchId).toBe('string');

  // Wait for asynchronous extraction before requesting the generated schema.
  let batchStatus = '';
  const batchDeadline = Date.now() + 60_000;
  while (Date.now() < batchDeadline) {
    const statusResponse = await api.get(`document/schemas/batch/${upload.uploadBatchId}/status`, {
      headers: auth,
    });
    if (statusResponse.ok()) {
      const status = await statusResponse.json();
      batchStatus = status.status;
      if (batchStatus === 'completed' || batchStatus === 'failed') break;
    } else if (statusResponse.status() !== 404 && statusResponse.status() !== 500) {
      throw new Error(`Schema batch status failed: ${statusResponse.status()} ${await statusResponse.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  expect(batchStatus).toBe('completed');

  // Get the extracted schema and give it a unique name for this test run.
  const batchSchemasResponse = await api.get(`document/schemas/batch/${upload.uploadBatchId}`, {
    headers: auth,
  });
  expect(batchSchemasResponse.status()).toBe(200);
  const batchSchemas = await batchSchemasResponse.json();
  expect(batchSchemas.length).toBeGreaterThan(0);

  const schemaId = batchSchemas[0].id;
  const schemaName = `API Spreadsheet Review ${Date.now()}`;

  const renameResponse = await api.patch(`document/schemas/${schemaId}`, {
    headers: auth,
    data: { newSchemaName: schemaName },
  });
  expect(renameResponse.status()).toBe(200);

  // Open a draft so the test can define its destination table.
  const draftResponse = await api.post(`document/schemas/${schemaId}/draft`, {
    headers: auth,
    data: {},
  });
  expect(draftResponse.status()).toBe(200);

  // Add the columns used by the spreadsheet CSV fixtures and mapping assertions.
  const tableResponse = await api.post(`document/schemas/${schemaId}/draft/table`, {
    headers: auth,
    data: {
      name: 'Line Items',
      columns: [
        { name: 'Description', key: 'description', type: 'string' },
        { name: 'Qty', key: 'qty', type: 'number' },
        { name: 'Unit Price', key: 'unitPrice', type: 'number' },
        { name: 'Total', key: 'total', type: 'number' },
      ],
    },
  });
  expect(tableResponse.status()).toBe(200);

  // Publish the schema so the action can use it during execution.
  const publishSchemaResponse = await api.post(`document/schemas/${schemaId}/publish`, {
    headers: auth,
    data: {},
  });
  expect(publishSchemaResponse.status()).toBe(200);
  expect((await publishSchemaResponse.json()).success).toBe(true);

  // Read installed versions because flow configuration requires them in the request payload.
  const spreadsheetPieceResponse = await api.get('pieces/%40docxster%2Fpiece-excel-review', { headers: auth });
  expect(spreadsheetPieceResponse.status()).toBe(200);
  const spreadsheetPieceVersion = (await spreadsheetPieceResponse.json()).version;

  const formsPieceResponse = await api.get('pieces/%40docxster%2Fpiece-forms', { headers: auth });
  expect(formsPieceResponse.status()).toBe(200);
  const formsPieceVersion = (await formsPieceResponse.json()).version;

  // Create a flow to contain the Process Spreadsheet test action.
  const flowResponse = await api.post('flows', {
    headers: auth,
    data: {
      displayName: `API Spreadsheet Review ${Date.now()}`,
      projectId,
    },
  });
  expect(flowResponse.status()).toBe(201);
  const flowId = (await flowResponse.json()).id;

  // Add the Chat UI trigger expected by the flow builder before inserting the action.
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
          input: { botName: 'API Spreadsheet Review Test' },
          inputUiInfo: {},
        },
      },
    },
  });
  expect(triggerResponse.status()).toBe(200);

  // Add Process Spreadsheet as step_1; each test fills its inputs before running it.
  const addActionResponse = await api.post(`flows/${flowId}`, {
    headers: auth,
    data: {
      type: 'ADD_ACTION',
      request: {
        parentStep: 'trigger',
        stepLocationRelativeToParent: 'AFTER',
        action: {
          name: 'step_1',
          valid: true,
          displayName: 'Process Spreadsheet',
          type: 'PIECE',
          settings: {
            pieceName: '@docxster/piece-excel-review',
            pieceVersion: spreadsheetPieceVersion,
            actionName: 'review_spreadsheet',
            input: {},
            inputUiInfo: {},
          },
        },
      },
    },
  });
  expect(addActionResponse.status()).toBe(200);

  return { schemaId, schemaName, flowId, spreadsheetPieceVersion };
}

export async function deleteSpreadsheetSchemaFixture(
  api: APIRequestContext,
  flowId: string,
  schemaId: string,
  schemaDeleted: boolean,
  auth: Record<string, string>,
) {
  // Remove the disposable flow after all Process Spreadsheet cases finish.
  if (flowId) {
    const deleteFlowResponse = await api.delete(`flows/${flowId}`, { headers: auth, data: {} });
    expect(deleteFlowResponse.status()).toBe(204);
  }

  // API_11 deletes the schema itself, so only remove it here for other test runs.
  if (schemaId && !schemaDeleted) {
    const deleteSchemaResponse = await api.delete(`document/schemas/${schemaId}`, { headers: auth, data: {} });
    expect([200, 202]).toContain(deleteSchemaResponse.status());
  }
}
