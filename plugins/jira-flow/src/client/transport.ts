export function createTransport(fetcher: typeof fetch = fetch) {
  let token: string | undefined;
  let connecting: Promise<any> | undefined;
  async function bootstrap() {
    if (!connecting)
      connecting = (async () => {
        const response = await fetcher('/jira-flow/bootstrap', {
          cache: 'no-store',
          signal: AbortSignal.timeout(15_000),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '无法连接任务看板');
        token = data.token;
        return data;
      })().finally(() => {
        connecting = undefined;
      });
    return connecting;
  }
  async function request(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    if (!token) await bootstrap();
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      const sentToken = token!;
      const headers = new Headers(init.headers);
      headers.set('x-jira-flow-token', sentToken);
      const response = await fetcher(url, { ...init, headers, cache: 'no-store', signal });
      if (response.status !== 403) return response;
      const body = await response
        .clone()
        .json()
        .catch(() => ({}));
      // Only retry a request rejected before dispatch by our page-token guard.
      // Jira failures and uncertain writes must never be replayed automatically.
      if (attempt || body.code !== 'PAGE_TOKEN_EXPIRED') return response;
      await response.body?.cancel();
      if (token === sentToken) await bootstrap();
    }
    throw new Error('页面连接无法恢复，请重新打开任务看板');
  }
  return { bootstrap, request };
}
