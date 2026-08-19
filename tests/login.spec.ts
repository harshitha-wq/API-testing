import { test, expect } from '@playwright/test';
import { login } from '../src/auth.api';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Authentication - Sign In', () => {
  test('Status code is 200 and response contains a token and projectId', async ({ request }) => {
    const responseStartTime = Date.now();
    const response = await login(request);
    const responseDurationMs = Date.now() - responseStartTime;
    expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
    expect.soft(response.status()).toBe(200);

    const body = await response.json();
    expect.soft(body.token).toBeTruthy();
    expect.soft(body.projectId).toBeTruthy();
  });

  test('fails with invalid credentials', async ({ request }) => {
    const responseStartTime = Date.now();
    const response = await login(request, { email: 'invalid@docxster.com', password: 'wrong-password' });
    const responseDurationMs = Date.now() - responseStartTime;
    expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);
    expect.soft(response.status()).toBe(401);
  });
});
