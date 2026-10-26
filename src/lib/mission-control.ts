import { fail, log } from "./cli.ts";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;
const DIGITS_RE = /^\d+$/u;
// Printable ASCII only: anything else is rejected by fetch with an error that echoes the value
const KEY_RE = /^[!-~]+$/u;
const TRAILING_SLASHES_RE = /\/+$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUEST_TIMEOUT_MS = 30_000;
const HTTP_NOT_FOUND = 404;

// all-digit names are rejected because Mission Control resolves them as agent ids
export const isValidAgentName = (name: string) =>
  NAME_RE.test(name) && !DIGITS_RE.test(name);

export const AGENT_NAME_RULES =
  "1-63 letters, digits, dots, hyphens or underscores, starting with a letter or digit, not only digits";

export const checkKey = (key: string, what: string): string => {
  if (!key) {
    fail(`${what} is empty`);
  }
  if (!KEY_RE.test(key)) {
    fail(`${what} contains invalid characters`);
  }
  return key;
};

// Same rules as the bundled mc-base-url.cjs, inlined so each built script stands alone.
export const normalizeUrl = (value: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return fail("Mission Control URL must be an absolute HTTP(S) URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    fail("Mission Control URL must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    fail("Mission Control URL must not contain credentials");
  }
  if (parsed.search || parsed.hash) {
    fail("Mission Control URL must not contain a query string or fragment");
  }
  if (parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname)) {
    log("warning: plain HTTP sends API keys unencrypted");
  }
  return parsed.toString().replace(TRAILING_SLASHES_RE, "");
};

interface ApiResult {
  status: number;
  ok: boolean;
  data: Record<string, unknown>;
}

const api = async (
  baseUrl: string,
  apiKey: string,
  method: string,
  route: string,
  body?: unknown
): Promise<ApiResult> => {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      method,
      // following a redirect would send the key to the redirect target
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch error messages can contain header values, so report only the cause code
    const err = (error ?? {}) as { name?: string; cause?: { code?: string } };
    return fail(
      `${method} ${route} failed: ${err.cause?.code ?? err.name ?? "network error"} (redirects are not followed)`
    );
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // non-JSON body: keep the status only
  }
  return { data, ok: res.ok, status: res.status };
};

const checked = <T>(method: string, route: string, result: ApiResult): T => {
  if (!result.ok) {
    const detail =
      typeof result.data.error === "string" ? ` ${result.data.error}` : "";
    fail(`${method} ${route} failed: HTTP ${result.status}${detail}`);
  }
  return result.data as T;
};

interface RegisterResponse {
  agent?: { id?: number | string; name?: string };
  registered?: boolean;
}

interface KeyResponse {
  api_key?: string;
  key?: { id?: number; key_prefix?: string };
}

export interface EnrollOptions {
  url: string;
  adminKey: string;
  agent: string;
  framework: string;
  keyName: string;
  expiresDays: number;
  // asked only when the agent already exists; issuing it a key is otherwise refused
  allowExisting: () => Promise<boolean>;
}

// Registers the agent with the admin key and issues it an operator-scoped key.
export const enrollAgent = async (opts: EnrollOptions): Promise<string> => {
  // look up first: registering an existing agent would reset its status to idle
  const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
  const lookup = await api(opts.url, opts.adminKey, "GET", agentRoute);
  if (lookup.status !== HTTP_NOT_FOUND) {
    checked("GET", agentRoute, lookup);
    if (!(await opts.allowExisting())) {
      fail(`agent "${opts.agent}" already exists; not issuing it another key`);
    }
  }

  const registerRoute = "/api/agents/register";
  const reg = checked<RegisterResponse>(
    "POST",
    registerRoute,
    await api(opts.url, opts.adminKey, "POST", registerRoute, {
      framework: opts.framework,
      name: opts.agent,
    })
  );
  const agentId = reg.agent?.id;
  if (agentId === undefined || agentId === null) {
    fail(`unexpected response from ${registerRoute}`);
  }
  log(
    `agent "${reg.agent?.name}" ${reg.registered ? "registered" : "exists"} (id ${agentId})`
  );

  // operator is the lowest role that can connect, heartbeat, poll the queue and update tasks
  const keysRoute = `/api/agents/${agentId}/keys`;
  const issued = checked<KeyResponse>(
    "POST",
    keysRoute,
    await api(opts.url, opts.adminKey, "POST", keysRoute, {
      expires_in_days: opts.expiresDays,
      name: opts.keyName,
      scopes: ["operator"],
    })
  );
  if (!issued.api_key) {
    return fail("unexpected response from the key endpoint");
  }
  log(
    `issued key ${issued.key?.key_prefix ?? ""}… (id ${issued.key?.id ?? "?"}), expires in ${opts.expiresDays} days`
  );
  return issued.api_key;
};

// Checks that Mission Control accepts the key, using a read-only request.
export const verifyKey = async (url: string, key: string, agent: string) => {
  const route = `/api/agents/${encodeURIComponent(agent)}`;
  const result = await api(url, key, "GET", route);
  if (result.status === HTTP_NOT_FOUND) {
    log(
      `warning: Mission Control accepted the key but has no agent "${agent}" yet; it is created on first connect`
    );
    return;
  }
  checked("GET", route, result);
  log(`key accepted for agent "${agent}"`);
};
