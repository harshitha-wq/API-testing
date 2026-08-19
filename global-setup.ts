import { request } from '@playwright/test';
import { env } from './config';
import { login } from './src/auth.api';
import { saveSession } from './session';
import { ensureHtsCodesFile } from './scripts/fetch-hts-codes';

async function globalSetup(): Promise<void> {
  const context = await request.newContext({ baseURL: env.apiBaseUrl });

  const response = await login(context);
  if (!response.ok()) {
    throw new Error(`Login failed during global setup: ${response.status()} ${await response.text()}`);
  }

  const body = await response.json();
  if (!body.token) {
    throw new Error('Login response did not contain a token.');
  }

  saveSession({ token: body.token, projectId: body.projectId, platformId: body.platformId, userId: body.id });
  await context.dispose();

  await ensureHtsCodesFile();
}

export default globalSetup;
