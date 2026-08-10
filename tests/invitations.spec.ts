import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

test.describe('User Invitations', () => {
  test('Inviting user , Get existing user invitations and Delete user invitation ', async ({ request }) => {
    const session = loadSession();
    const email = `harshitha@docxster.com`;

    // Step 1: Send an invitation for this project
    const response = await request.post('user-invitations', {
      data: {
        type: 'PROJECT',
        email,
        projectId: session.projectId,
        projectRole: 'ADMIN',
      },
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    expect.soft(response.status()).toBe(201);

    const body = await response.json();
    expect.soft(body.platformId).toBeTruthy();
    expect.soft(body.type).toBe('PROJECT');
    expect.soft(body.email).toBe(email);
    expect.soft(body.projectId).toBe(session.projectId);
    expect.soft(body.status).toBe('PENDING');

    // Step 2: Confirm the invitation shows up in the pending invitations list
    const listResponse = await request.get('user-invitations', {
      params: {
        type: 'PROJECT',
        projectId: session.projectId,
        status: 'PENDING',
      },
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    expect.soft(listResponse.status()).toBe(200);

    const listBody = await listResponse.json();
    expect.soft(Array.isArray(listBody.data)).toBe(true);
    expect.soft(listBody.data.some((invitation: { id: string }) => invitation.id === body.id)).toBe(true);

    // Step 3: Revoke the invitation (cleanup so re-runs don't hit a duplicate invite)
    const deleteResponse = await request.delete(`user-invitations/${body.id}`, {
      data: {},
      headers: {
        Authorization: `Bearer ${session.token}`,
      },
    });

    expect.soft(deleteResponse.status()).toBe(204);
  });
});
