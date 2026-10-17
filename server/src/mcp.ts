import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { FailureLimiter, extractBearer } from './auth.js';
import { VaultError } from './errors.js';
import type { Logger } from './logger.js';
import type { Vault } from './vault.js';

const projectRef = z.string().min(1).describe('Project name (case-insensitive) or project id');
const status = z.enum(['active', 'inactive']);

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function toolError(e: unknown, log: Logger, tool: string): CallToolResult {
  if (e instanceof VaultError) {
    return { isError: true, content: [{ type: 'text', text: `${e.code}: ${e.message}` }] };
  }
  log.error('MCP tool failed', { tool, error: e instanceof Error ? e.message : String(e) });
  return { isError: true, content: [{ type: 'text', text: 'INTERNAL_ERROR: Unexpected server error' }] };
}

export function buildMcpServer(vault: Vault, log: Logger): McpServer {
  const server = new McpServer({ name: 'project-vault', version: '1.0.0' });

  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean },
    handler: (args: z.objectOutputType<S, z.ZodTypeAny>) => unknown,
  ) => {
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
      try {
        return ok(await handler(args));
      } catch (e) {
        return toolError(e, log, name);
      }
    }) as never);
  };

  tool('list_projects', 'List all projects (folders) with credential counts.', {}, { readOnlyHint: true }, () => ({
    projects: vault.listProjects(),
  }));

  tool('create_project', 'Create a new project. Project names are unique (case-insensitive).', { name: z.string().min(1).max(100) }, {}, ({ name }) => ({
    project: vault.createProject(name),
  }));

  tool(
    'list_credentials',
    'List credentials of a project WITHOUT secrets. Optional `query` filters by service or key name; `status` filters by status.',
    { project: projectRef, query: z.string().optional(), status: z.enum(['active', 'inactive', 'all']).optional() },
    { readOnlyHint: true },
    ({ project, query, status: st }) => {
      const p = vault.resolveProject(project);
      return { project: { id: p.id, name: p.name }, credentials: vault.listCredentials({ projectId: p.id, query, status: st }) };
    },
  );

  tool(
    'get_credential',
    'Get one credential INCLUDING its secret. Identify it either by `id`, or by `project` + `service` + `name`.',
    {
      id: z.string().optional().describe('Credential id'),
      project: projectRef.optional(),
      service: z.string().optional(),
      name: z.string().optional().describe('Key name, e.g. "Production API"'),
    },
    { readOnlyHint: true },
    ({ id, project, service, name }) => {
      if (id) return { credential: vault.revealCredential(id) };
      if (!project || !service || !name) {
        throw new VaultError('VALIDATION_ERROR', 'Provide either "id", or all of "project", "service" and "name"');
      }
      const p = vault.resolveProject(project);
      const found = vault.findCredential(p.id, service, name);
      if (!found) throw new VaultError('CREDENTIAL_NOT_FOUND', `Credential "${name}" for service "${service}" not found in project "${p.name}"`);
      return { credential: vault.revealCredential(found.id) };
    },
  );

  tool(
    'upsert_credential',
    'Create or update a credential. With `id` that record is updated; otherwise the record with the same project + service + name is updated, ' +
      'or a new one is created (then `secret` is required). Omit `secret` (or pass an empty string) to keep the stored secret.',
    {
      project: projectRef,
      id: z.string().optional(),
      service: z.string().min(1).max(100).describe('Service, e.g. GitHub, GitLab, server, database'),
      name: z.string().min(1).max(200).describe('Key name, e.g. "Production API"'),
      secret: z.string().max(65536).optional(),
      status: status.optional(),
    },
    { idempotentHint: true },
    ({ project, ...input }) => vault.upsertCredential(project, input),
  );

  tool(
    'set_credential_status',
    'Activate or deactivate a credential.',
    { id: z.string().min(1), status },
    { idempotentHint: true },
    ({ id, status: st }) => ({ credential: vault.setCredentialStatus(id, st) }),
  );

  tool('delete_credential', 'Permanently delete one credential.', { id: z.string().min(1) }, { destructiveHint: true }, ({ id }) => ({
    deleted: vault.deleteCredential(id),
  }));

  tool(
    'delete_inactive_credentials',
    'Permanently delete all INACTIVE credentials of a project. Active ones are kept. Returns the number of deleted records.',
    { project: projectRef },
    { destructiveHint: true },
    ({ project }) => {
      const p = vault.resolveProject(project);
      return { project: { id: p.id, name: p.name }, deleted: vault.deleteInactiveCredentials(p.id) };
    },
  );

  return server;
}

function jsonRpcError(res: Response, httpStatus: number, code: number, message: string) {
  res.status(httpStatus).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/**
 * Stateless Streamable HTTP MCP endpoint. Every request is authenticated with
 * `Authorization: Bearer <token>`, so a rotated token stops working immediately.
 */
export function mcpRouter(vault: Vault, log: Logger, limiter: FailureLimiter): Router {
  const r = Router();

  r.post('/', async (req: Request, res: Response) => {
    const client = req.ip ?? 'unknown';
    const wait = limiter.retryAfter(client);
    if (wait > 0) {
      res.set('Retry-After', String(wait));
      return jsonRpcError(res, 429, -32029, `Too many failed authentication attempts. Try again in ${wait} s`);
    }
    if (!vault.verifyAccessToken(extractBearer(req))) {
      limiter.fail(client);
      log.warn('MCP request with invalid or missing token', { ip: client });
      res.set('WWW-Authenticate', 'Bearer realm="project-vault"');
      return jsonRpcError(res, 401, -32001, 'Unauthorized: invalid or missing access token. Send header "Authorization: Bearer <token>".');
    }
    limiter.reset(client);

    const server = buildMcpServer(vault, log);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  r.all('/', (_req, res) => {
    res.set('Allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed. This MCP endpoint is stateless and accepts POST only.');
  });

  return r;
}
