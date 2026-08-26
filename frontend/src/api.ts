export type User = { id: string; email: string; displayName: string };

export type Candidate = { id: string; assetId: string; url: string | null; contentType: string | null };
export type TurnGeneration = {
  generationId: string;
  status: "completed" | "failed";
  patch: unknown;
  renderPrompt: string | null;
  selectedCandidateId: string | null;
  selectedRevisionId: string | null;
  candidate?: Candidate;
};
export type TurnDetail = {
  turnId: string;
  projectId: string;
  status: "queued" | "running" | "completed" | "failed";
  userMessage: string;
  generations: TurnGeneration[];
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: init?.body ? { "content-type": "application/json" } : undefined,
    ...init,
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? response.statusText);
  }
  return payload as T;
}

export const api = {
  me: () => request<User>("/auth/me"),
  register: (input: { email: string; password: string; displayName?: string }) =>
    request<User>("/auth/register", { method: "POST", body: JSON.stringify(input) }),
  login: (input: { email: string; password: string }) =>
    request<User>("/auth/login", { method: "POST", body: JSON.stringify(input) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  createProject: (input: { name: string; anchorAsset?: { assetId: string; uri: string; metadata?: unknown } }) =>
    request<{ id: string; name: string }>("/projects", {
      method: "POST",
      body: JSON.stringify({
        initialState: { subject: { identity: { preserve: true } }, constraints: [] },
        ...input,
      }),
    }),
  upload: async (file: File) => {
    const response = await fetch("/uploads", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": file.type },
      body: await file.arrayBuffer(),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new ApiError(response.status, payload?.error?.code ?? "UPLOAD_FAILED", payload?.error?.message ?? "上传失败");
    }
    return payload as { assetId: string; uri: string; metadata: Record<string, unknown> };
  },
  sendMessage: (projectId: string, message: string) =>
    request<{ turnId: string; replayed: boolean }>(`/projects/${projectId}/messages`, {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ message }),
    }),
  turn: (projectId: string, turnId: string) =>
    request<TurnDetail>(`/projects/${projectId}/turns/${turnId}`),
  select: (projectId: string, turnId: string, generationId: string, candidateId: string) =>
    request<{ revisionId: string }>(`/projects/${projectId}/turns/${turnId}/selections`, {
      method: "POST",
      body: JSON.stringify({ generationId, candidateId }),
    }),
};
