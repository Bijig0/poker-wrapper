/** Small HTTP helpers with Python urllib's shape: a timeout, and a failure as a value rather than a throw. */

/** GET or POST JSON; the parsed reply, or throws (the caller decides what a failure means). */
export async function fetchJson(url: string, opts: { body?: unknown; timeoutS?: number; method?: string } = {}): Promise<{ status: number; json: any; statusText: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), (opts.timeoutS ?? 5) * 1000);
  try {
    const r = await fetch(url, {
      method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
      headers: opts.body === undefined ? {} : { "Content-Type": "application/json" },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctl.signal,
    });
    const text = await r.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = null;
    }
    return { status: r.status, json, statusText: r.statusText };
  } finally {
    clearTimeout(t);
  }
}

/** The raw body of a GET, or null on any failure (urllib's `get` in _health_check). */
export async function fetchBytes(url: string, timeoutS: number): Promise<Uint8Array | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) return null;
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** POST JSON to a peer wrapper; {ok: false, error} on failure (launch._peer_post / _api_post). */
export async function postJson(url: string, body: unknown, timeoutS = 25.0): Promise<Record<string, any>> {
  try {
    const r = await fetchJson(url, { body, timeoutS });
    if (r.status >= 400) return { ok: false, error: `HTTP Error ${r.status}: ${r.statusText}` };
    return r.json ?? {};
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** GET JSON from a peer; {ok: false, error} on failure (launch._peer_get). */
export async function getJson(url: string, timeoutS = 3.0): Promise<Record<string, any>> {
  try {
    const r = await fetchJson(url, { timeoutS });
    if (r.status >= 400) return { ok: false, error: `HTTP Error ${r.status}: ${r.statusText}` };
    return r.json ?? {};
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
