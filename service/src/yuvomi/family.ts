import { config } from '../config.js';

export async function loadFamilyMembers(cookieHeader?: string): Promise<unknown[]> {
  if (!cookieHeader) return [];
  const response = await fetch(`${config.yuvomiInternalUrl}/api/v1/family/members`, {
    headers: { cookie: cookieHeader, accept: 'application/json' },
    redirect: 'manual',
  });
  if (!response.ok) return [];
  const payload = await response.json() as { data?: unknown[] };
  return Array.isArray(payload.data) ? payload.data : [];
}
