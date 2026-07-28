// Minimal typed client for the studio-backend REST API (/cf prefix).
// The live OpenAPI contract is served by the backend at /cf/docs.

export interface Me {
  subject_id: string;
  subject_type?: string;
  subject_tenant_id: string;
}

export interface Tenant {
  id: string;
  name: string;
  tenant_type: string;
  self_managed: boolean;
}

export interface Page<T> {
  items: T[];
  page_info?: { next_cursor: string | null; prev_cursor: string | null; limit: number };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

export function apiUrl(path: string): string {
  return `/cf${path.startsWith("/") ? path : `/${path}`}`;
}

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  me: (token: string) => request<Me>("/account-management/v1/me", token),
  tenantChildren: (token: string, tenantId: string) =>
    request<Page<Tenant>>(`/account-management/v1/tenants/${tenantId}/children`, token),
};
