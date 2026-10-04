/**
 * GTO Wizard's hand-history ANALYZER, driven the way its web app drives it (read off app.gtowizard.com on 2026-10-04,
 * /analyze/v4/hands/table → Upload → "Upload and Analyze"):
 *
 *   1. POST /v4/hand-history/files/ {filename, is_without_analysis:false}  → {uuid, url, fields}  (a presigned S3 POST)
 *   2. POST <url> multipart: the presigned fields, Content-Type text/plain, then the file          → 204
 *   3. GTO Wizard parses and solves it on its side; GET /v4/hand-history/files/ shows the file's status
 *      (UPLOADING → … → FULLY_ANALYZED) with the hand counts (total, duplicate, parsing errors, solved).
 *
 * The account is a GTO Wizard session from the pool (services/gtowSessions.ts: the bearer token is sniffed from that
 * account's signed-in client), so hands land in that account's Analyze tab. Each call goes through the request
 * ledger like every other api.gtowizard.com request. The old v2 route (/v2/poker/hand-history/files/) answers 404.
 */
import { gtowRequests } from "./gtowRequestLog";
import { gtowSessions, type GtowSessionId } from "./gtowSessions";

const API = "https://api.gtowizard.com";

export interface AnalyzerFile {
  id: string;
  original_name: string;
  status: string;
  error_status: string;
  is_analysis_in_flight: boolean;
  total_hands: number;
  duplicate_hands: number;
  parsing_error_hands: number;
  parser_unsupported_hands: number;
  over_limit_hands: number;
  solved_hands: number;
  error_start_lines: unknown[];
  [k: string]: unknown;
}

async function authHeaders(account: GtowSessionId): Promise<Record<string, string>> {
  const token = await gtowSessions.tokenFor(account);
  if (!token) throw new Error(`no GTO Wizard token for "${account}" — is that account's client open and signed in?`);
  return { Authorization: `Bearer ${token}` };
}

/** Upload one hand-history text file to the account's analyzer; resolves with the file id once S3 has it. */
export async function uploadToAnalyzer(text: string, filename: string, account: GtowSessionId = "primary"): Promise<string> {
  const auth = await authHeaders(account);
  const r = await gtowRequests.fetch(account, "other", `${API}/v4/hand-history/files/`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({ filename, is_without_analysis: false }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`analyzer refused the file (${r.status}): ${(await r.text()).slice(0, 300)}`);
  const { uuid, url, fields } = (await r.json()) as { uuid: string; url: string; fields: Record<string, string> };
  // the web app's field order and spelling (S3 checks the policy, not the case of these names)
  const form = new FormData();
  form.append("key", fields.key);
  form.append("Content-Type", "text/plain");
  form.append("X-Amz-Credential", fields["x-amz-credential"]);
  form.append("X-Amz-Algorithm", fields["x-amz-algorithm"]);
  form.append("X-Amz-Date", fields["x-amz-date"]);
  form.append("policy", fields.policy);
  form.append("X-Amz-Signature", fields["x-amz-signature"]);
  form.append("X-Amz-Storage-Class", fields["x-amz-storage-class"]);
  if (fields["x-amz-security-token"]) form.append("X-amz-security-token", fields["x-amz-security-token"]);
  form.append("file", new Blob([text], { type: "text/plain" }), filename);
  const s3 = await fetch(url, { method: "POST", body: form, signal: AbortSignal.timeout(120_000) });
  if (s3.status !== 200 && s3.status !== 204) throw new Error(`S3 refused the upload (${s3.status}): ${(await s3.text()).slice(0, 300)}`);
  return uuid;
}

/** The account's most recent analyzer files, newest first. */
export async function analyzerFiles(account: GtowSessionId = "primary", limit = 20): Promise<AnalyzerFile[]> {
  const r = await gtowRequests.fetch(account, "other", `${API}/v4/hand-history/files/?limit=${limit}&offset=0&ordering=-created_at`, {
    headers: await authHeaders(account),
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`analyzer file list refused (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return ((await r.json()) as { items: AnalyzerFile[] }).items;
}

/** Poll until GTO Wizard has finished the file (or the deadline passes); returns its last state. */
export async function waitForAnalyzer(fileId: string, account: GtowSessionId = "primary", opts: { timeoutMs?: number; everyMs?: number; onTick?: (f: AnalyzerFile) => void } = {}): Promise<AnalyzerFile | null> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  let last: AnalyzerFile | null = null;
  while (Date.now() < deadline) {
    await Bun.sleep(opts.everyMs ?? 10_000);
    last = (await analyzerFiles(account, 20)).find((f) => f.id === fileId) ?? last;
    if (last) opts.onTick?.(last);
    if (last && !last.is_analysis_in_flight && last.status !== "UPLOADING") return last;
  }
  return last;
}
