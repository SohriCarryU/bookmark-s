export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      result.error || `请求失败（${response.status}），请稍后再试。`,
    );
  return result as T;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "出了点小问题，请稍后再试。";
}
