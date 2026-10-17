import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADMIN, createTestContext, listen, type TestContext } from './helpers.js';

let ctx: TestContext;
let server: Server;
let baseUrl: string;

beforeEach(async () => {
  ctx = await createTestContext();
  ({ server, url: baseUrl } = await listen(ctx.app));
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  ctx.close();
});

async function connect(token: string) {
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content[0]?.text ?? '';
  return { isError: !!res.isError, text, data: res.isError ? undefined : JSON.parse(text) };
}

describe('MCP endpoint', () => {
  it('exposes all required tools', async () => {
    const client = await connect(ADMIN.token);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'create_project',
        'delete_credential',
        'delete_inactive_credentials',
        'get_credential',
        'list_credentials',
        'list_projects',
        'set_credential_status',
        'upsert_credential',
      ].sort(),
    );
    await client.close();
  });

  it('rejects missing and invalid tokens with 401', async () => {
    const noAuth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(noAuth.status).toBe(401);
    expect(noAuth.headers.get('www-authenticate')).toContain('Bearer');
    expect((await noAuth.json()).error.message).toMatch(/invalid or missing access token/i);

    await expect(connect('vlt_definitely_not_the_right_token_xxxxx')).rejects.toThrow();
  });

  it('lets an agent create, read, update and disable credentials', async () => {
    const client = await connect(ADMIN.token);
    expect((await call(client, 'create_project', { name: 'CRM' })).data.project.name).toBe('CRM');
    expect((await call(client, 'list_projects')).data.projects).toHaveLength(1);

    const created = await call(client, 'upsert_credential', { project: 'crm', service: 'GitHub', name: 'Production API', secret: 'ghp_one' });
    expect(created.data.created).toBe(true);
    expect(created.text).not.toContain('ghp_one');
    const id = created.data.credential.id as string;

    const updated = await call(client, 'upsert_credential', { project: 'CRM', service: 'github', name: 'production api', secret: 'ghp_two' });
    expect(updated.data).toMatchObject({ created: false, credential: { id } });

    // Without a secret the stored one is kept.
    await call(client, 'upsert_credential', { project: 'CRM', id, service: 'GitHub', name: 'Production API v2' });
    const got = await call(client, 'get_credential', { id });
    expect(got.data.credential).toMatchObject({ id, name: 'Production API v2', secret: 'ghp_two', status: 'active' });
    const byName = await call(client, 'get_credential', { project: 'CRM', service: 'GitHub', name: 'Production API v2' });
    expect(byName.data.credential.secret).toBe('ghp_two');

    const list = await call(client, 'list_credentials', { project: 'CRM' });
    expect(list.data.credentials).toHaveLength(1);
    expect(list.text).not.toContain('ghp_two');

    const disabled = await call(client, 'set_credential_status', { id, status: 'inactive' });
    expect(disabled.data.credential.status).toBe('inactive');
    await client.close();
  });

  it('deletes credentials and reports the number of removed inactive ones', async () => {
    const client = await connect(ADMIN.token);
    await call(client, 'create_project', { name: 'Shop' });
    const ids: string[] = [];
    for (const name of ['a', 'b', 'c']) {
      ids.push((await call(client, 'upsert_credential', { project: 'Shop', service: 'DB', name, secret: name })).data.credential.id);
    }
    await call(client, 'set_credential_status', { id: ids[0], status: 'inactive' });
    await call(client, 'set_credential_status', { id: ids[1], status: 'inactive' });
    expect((await call(client, 'delete_inactive_credentials', { project: 'Shop' })).data.deleted).toBe(2);
    expect((await call(client, 'delete_inactive_credentials', { project: 'Shop' })).data.deleted).toBe(0);
    expect((await call(client, 'list_credentials', { project: 'Shop' })).data.credentials.map((c: { id: string }) => c.id)).toEqual([ids[2]]);

    expect((await call(client, 'delete_credential', { id: ids[2] })).isError).toBe(false);
    expect((await call(client, 'list_credentials', { project: 'Shop' })).data.credentials).toEqual([]);
    await client.close();
  });

  it('returns clear tool errors', async () => {
    const client = await connect(ADMIN.token);
    const missingProject = await call(client, 'list_credentials', { project: 'Nope' });
    expect(missingProject).toMatchObject({ isError: true });
    expect(missingProject.text).toMatch(/PROJECT_NOT_FOUND/);

    const missingCred = await call(client, 'get_credential', { id: 'nope' });
    expect(missingCred.text).toMatch(/CREDENTIAL_NOT_FOUND/);

    const badStatus = await call(client, 'set_credential_status', { id: 'x', status: 'paused' });
    expect(badStatus.isError).toBe(true);
    expect(badStatus.text).toMatch(/status/i);

    await call(client, 'create_project', { name: 'CRM' });
    const noSecret = await call(client, 'upsert_credential', { project: 'CRM', service: 'GitHub', name: 'New' });
    expect(noSecret.text).toMatch(/VALIDATION_ERROR.*secret/);

    const ambiguous = await call(client, 'get_credential', { project: 'CRM' });
    expect(ambiguous.text).toMatch(/VALIDATION_ERROR/);
    await client.close();
  });

  it('stops accepting the old token immediately after rotation', async () => {
    const client = await connect(ADMIN.token);
    expect((await call(client, 'list_projects')).isError).toBe(false);

    const newToken = ctx.vault.rotateAccessToken();
    await expect(client.listTools()).rejects.toThrow();
    await expect(connect(ADMIN.token)).rejects.toThrow();

    const fresh = await connect(newToken);
    expect((await call(fresh, 'list_projects')).isError).toBe(false);
    await fresh.close();
  });
});
