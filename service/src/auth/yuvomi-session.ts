import { config } from '../config.js';

export type PermissionLevel = 'none' | 'read' | 'write';
export interface YuvomiUser {
  id: number;
  display_name?: string;
  role?: string;
  permissions?: { modules?: Record<string, PermissionLevel> };
}

type JsonRecord = Record<string, unknown>;
const cache = new Map<string, { expiresAt: number; user: YuvomiUser }>();

function record(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

export function normalizeYuvomiUser(body: unknown): YuvomiUser {
  const root = record(body);
  const data = record(root?.data);
  const candidate = record(root?.user) ?? record(data?.user) ?? (data && 'id' in data ? data : null);
  if (!candidate) throw new Error('Yuvomi auth response did not contain a user.');
  const id = Number(candidate.id);
  if (!Number.isSafeInteger(id) || id < 1) throw new Error('Yuvomi auth response contained an invalid user id.');
  const permissionSource = record(candidate.permissions) ?? record(root?.permissions) ?? record(data?.permissions);
  const rawModules = record(permissionSource?.modules);
  const modules: Record<string, PermissionLevel> = {};
  for (const [key, value] of Object.entries(rawModules ?? {})) {
    if (value === 'none' || value === 'read' || value === 'write') modules[key] = value;
  }
  return {
    id,
    ...(typeof candidate.display_name === 'string' ? { display_name: candidate.display_name } : {}),
    ...(typeof candidate.role === 'string' ? { role: candidate.role } : {}),
    permissions: { modules },
  };
}

export async function resolveYuvomiUser(cookieHeader?: string): Promise<YuvomiUser | null> {
  if (!cookieHeader) return null;
  const cached = cache.get(cookieHeader);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  if (cached) cache.delete(cookieHeader);
  const response = await fetch(`${config.yuvomiInternalUrl}/api/v1/auth/me`, {
    headers: { cookie: cookieHeader, accept: 'application/json' },
    redirect: 'manual',
  });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error(`Yuvomi auth check failed with HTTP ${response.status}`);
  const user = normalizeYuvomiUser(await response.json());
  cache.set(cookieHeader, { expiresAt: Date.now() + 3000, user });
  return user;
}

export function daybookPermission(user: YuvomiUser): PermissionLevel {
  const value = user.permissions?.modules?.['ext:daybook'];
  if (value === 'read' || value === 'write') return value;
  return 'none';
}
