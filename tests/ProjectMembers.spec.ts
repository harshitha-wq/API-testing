import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

const RESPONSE_TIME_LIMIT_MS = 1000;

test.describe('Project Members', () => {
    test.describe.configure({ mode: 'serial' });
    const session = loadSession();

    let memberId: string;
    let projectRoleId: string;

    // Lists the members of a project (the project owner is a member by default).
    test('Get Project Member list of particular project', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get('project-members', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        const member = body.data[0];
        expect.soft(typeof member.id).toBe('string');
        expect.soft(member.projectId).toBe(session.projectId);
        expect.soft(typeof member.projectRoleId).toBe('string');

        memberId = member.id;
        projectRoleId = member.projectRoleId;
    });

    // Lists the members that hold a given project role, via the nested project-roles route.
    test('Get a list of members with a particular role in a specific project.', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.get(`project-roles/${projectRoleId}/project-members`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        const member = body.data.find((m: { id: string }) => m.id === memberId);
        expect.soft(member.projectRoleId).toBe(projectRoleId);
        expect.soft(member.projectId).toBe(session.projectId);
    });

    test.skip('Remove the project memeber from project', async ({ request }) => {
        const responseStartTime = Date.now();
        const response = await request.delete(`project-members/${memberId}`, {
            data: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });
        const responseDurationMs = Date.now() - responseStartTime;
        expect.soft(responseDurationMs).toBeLessThan(RESPONSE_TIME_LIMIT_MS);

        expect(response.status()).toBe(204);
    });
});
