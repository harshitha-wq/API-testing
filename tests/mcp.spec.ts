import { test, expect } from '@playwright/test';
import { loadSession } from '../session';

test.describe('mcp', () => {
    test.describe.configure({ mode: 'serial' });

    let mcpServerId: string;
    let mcpServerToken: string;

    // Creates a new MCP server for a project, with a name and an auto-generated access token.
    test('Create a new MCP server', async ({ request }) => {
        const session = loadSession();

        const response = await request.post('mcp-servers', {
            data: {
                name: 'Test MCP Server',
                projectId: session.projectId,
            }, headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.name).toBe('Test MCP Server');
        expect.soft(body.projectId).toBe(session.projectId);

        mcpServerId = body.id;
        mcpServerToken = body.token;
    });

    // Lists all MCP servers that exist for a given project.
    test('List MCP servers', async ({ request }) => {
        const session = loadSession();

        const response = await request.get('mcp-servers', {
            params: { projectId: session.projectId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        const server = body.data.find((s: { id: string }) => s.id === mcpServerId);

        expect.soft(server?.name).toBe('Test MCP Server');
        expect.soft(server?.projectId).toBe(session.projectId);
    });
    // Looks up one specific MCP server by ID and returns its full details.
    test('Get an MCP server by ID', async ({ request }) => {
        const session = loadSession();

        const response = await request.get(`mcp-servers/${mcpServerId}`, {
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(mcpServerId);
        expect.soft(body.name).toBe('Test MCP Server');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.created).toBe('string');
        expect.soft(typeof body.updated).toBe('string');
        expect.soft(typeof body.token).toBe('string');
        expect.soft(typeof body.externalId).toBe('string');
        expect.soft(typeof body.agentId).toBe('string');
        expect.soft(typeof body.userId).toBe('string');
        expect.soft(Array.isArray(body.tools)).toBe(true);
    });

    // Updates an MCP server's settings: renames it and attaches a tool (a piece/action or flow it can invoke).
    test('Update an MCP server', async ({ request }) => {
        const session = loadSession();

        const response = await request.post(`mcp-servers/${mcpServerId}`, {
            data: {
                name: 'Updated MCP Server',
                tools: [
                    {
                        type: 'PIECE',
                        pieceMetadata: {
                            pieceName: 'test-piece',
                            pieceVersion: '1.0.0',
                            actionName: 'test_action',
                            actionDisplayName: 'Test Action',
                            logoUrl: 'https://example.com/logo.png',
                        },
                    },
                ],
            },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(mcpServerId);
        expect.soft(body.name).toBe('Updated MCP Server');
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(Array.isArray(body.tools)).toBe(true);
        expect.soft(body.tools.length).toBe(1);
        expect.soft(body.tools[0].type).toBe('PIECE');
        expect.soft(body.tools[0].pieceMetadata?.pieceName).toBe('test-piece');
    });

    // Invalidates the server's current access token and issues a new one.
    test('Rotate the MCP token', async ({ request }) => {
        const session = loadSession();

        const response = await request.post(`mcp-servers/${mcpServerId}/rotate`, {
            data: {},
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(body.id).toBe(mcpServerId);
        expect.soft(body.projectId).toBe(session.projectId);
        expect.soft(typeof body.token).toBe('string');
        expect.soft(body.token).not.toBe(mcpServerToken);

        mcpServerToken = body.token;
    });

    // Shows the history of times this MCP server's tools were actually invoked (input, output, success/failure).
    test('Get MCP runs for a server', async ({ request }) => {
        const session = loadSession();

        const response = await request.get('mcp-runs', {
            params: { projectId: session.projectId, mcpId: mcpServerId },
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(200);
        const body = await response.json();
        expect.soft(Array.isArray(body.data)).toBe(true);
        // This server was never actually invoked as an MCP tool, so it has no runs yet.
        expect.soft(body.data.length).toBe(0);
    });

    // Permanently deletes the MCP server.
    test('Delete an MCP server by ID', async ({ request }) => {
        const session = loadSession();

        const response = await request.delete(`mcp-servers/${mcpServerId}`, {
            data: {},
            headers: {
                Authorization: `Bearer ${session.token}`,
            },
        });

        expect.soft(response.status()).toBe(204);
    });
});
