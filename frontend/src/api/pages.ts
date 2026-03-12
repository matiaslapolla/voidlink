const API_BASE = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export interface PageSummary {
  id: string;
  title: string;
  parent_id?: string | null;
  updated_at: string;
}

export interface PageFull {
  id: string;
  title: string;
  content: string;
  parent_id?: string | null;
  created_at: string;
  updated_at: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const pagesApi = {
  list: () => request<PageSummary[]>("/api/pages"),

  get: (id: string) => request<PageFull>(`/api/pages/${id}`),

  create: (data: { id?: string; title?: string; content?: string; parent_id?: string } = {}) =>
    request<PageFull>("/api/pages", {
      method: "POST",
      body: JSON.stringify(data),
    }),

  update: (id: string, data: { title?: string; content?: string }) =>
    request<PageFull>(`/api/pages/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<void>(`/api/pages/${id}`, { method: "DELETE" }),
};
