export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : null;
  if (!response.ok)
    throw new ApiError(
      data?.error ||
        (response.status === 401
          ? "Sua sessão expirou. Entre novamente."
          : "Não foi possível concluir. Tente novamente."),
      response.status,
      data?.code,
    );
  if (!data)
    throw new ApiError(
      "O servidor retornou uma resposta inesperada. Tente novamente.",
      response.status,
    );
  return data as T;
}
export const post = <T>(path: string, body: unknown = {}) =>
  api<T>(path, { method: "POST", body: JSON.stringify(body) });
export const patch = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const remove = <T>(path: string, body: unknown) =>
  api<T>(path, { method: "DELETE", body: JSON.stringify(body) });
export function message(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Algo deu errado. Tente novamente.";
}
export async function exportReport(month: string, format: "pdf" | "csv" = "pdf") {
  const res = await fetch(
    format === "pdf"
      ? `/api/schedule/export?month=${encodeURIComponent(month)}`
      : `/api/reports/export?month=${encodeURIComponent(month)}`,
    { credentials: "same-origin" },
  );
  if (!res.ok) {
    let error = "Não foi possível exportar o relatório.";
    try {
      error = (await res.json()).error || error;
    } catch {}
    throw new Error(error);
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = `escala-amil-${month}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
