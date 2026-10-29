import { fail, log } from "./cli.ts";

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;
// Printable ASCII only: anything else is rejected by fetch with an error that echoes the value
const KEY_RE = /^[!-~]+$/u;
const TRAILING_SLASHES_RE = /\/+$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const REQUEST_TIMEOUT_MS = 30_000;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const DAY_MS = 86_400_000;
// C0/C1 control characters (e.g. ESC), bidi controls, zero-width characters and line
// separators: server text must not drive the terminal or change what it shows
const CONTROL_CHARS_RE =
  // oxlint-disable-next-line no-control-regex
  /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/gu;

// Text from the server, made safe to print.
const printable = (value: unknown) =>
  String(value).replaceAll(CONTROL_CHARS_RE, "?");

// names that read as a number (e.g. 42, 1e3) are rejected because Mission Control
// resolves them as agent ids
export const isValidAgentName = (name: string) =>
  NAME_RE.test(name) && Number.isNaN(Number(name));

export const AGENT_NAME_RULES =
  "1-63 letters, digits, dots, hyphens or underscores, starting with a letter or digit, not a number";

export const checkKey = (key: unknown, what: string): string => {
  if (typeof key !== "string" || !key) {
    return fail(`${what} is empty or not a string`);
  }
  if (!KEY_RE.test(key)) {
    fail(`${what} contains invalid characters`);
  }
  return key;
};

// Checks the URL the user typed: absolute HTTP(S), no credentials, query or fragment.
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
  return parsed.toString().replace(TRAILING_SLASHES_RE, "");
};

const sameUrl = (a: string, b: string) => {
  try {
    const href = (value: string) =>
      new URL(value).href.replace(TRAILING_SLASHES_RE, "");
    return href(a) === href(b);
  } catch {
    return false;
  }
};

// A key from the environment goes only to the URL exported with it (MC_URL), so a
// key for one instance is never sent to another.
export const envKey = (
  name: "MC_API_KEY" | "MC_ADMIN_API_KEY",
  url: string
): string | undefined => {
  const key = process.env[name]?.trim();
  if (!key) {
    return;
  }
  if (!sameUrl(process.env.MC_URL?.trim() ?? "", url)) {
    log(`ignoring ${name} from the environment: MC_URL is not ${url}`);
    return;
  }
  log(`using ${name} from the environment`);
  return key;
};

// Plain HTTP to another machine sends API keys unencrypted.
export const isRemotePlainHttp = (url: string) => {
  const parsed = new URL(url);
  return parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname);
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
  body?: unknown,
  agentName?: string
): Promise<ApiResult> => {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        // makes Mission Control reject an agent key that belongs to another agent
        ...(agentName ? { "x-agent-name": agentName } : {}),
      },
      method,
      // following a redirect would send the key to the redirect target
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // fetch error messages can contain header values, so report only the cause code
    const err = (error ?? {}) as {
      name?: string;
      cause?: { code?: string; message?: string };
    };
    const reason =
      err.cause?.message === "unexpected redirect"
        ? "the server answered with a redirect, which is not followed so the key goes only to this URL"
        : (err.cause?.code ?? err.name ?? "network error");
    return fail(`${method} ${route} failed: ${reason}`);
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
      typeof result.data.error === "string"
        ? ` ${printable(result.data.error)}`
        : "";
    fail(`${method} ${route} failed: HTTP ${result.status}${detail}`);
  }
  return result.data as T;
};

interface AgentResponse {
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
  // appended to the refusal, e.g. how to allow it
  existingHint: string;
}

// The agent's id, after checking the response names the agent we asked for.
const agentIdOf = (
  response: AgentResponse,
  agent: string,
  route: string
): string => {
  const id = response.agent?.id;
  if (
    (typeof id !== "number" && typeof id !== "string") ||
    response.agent?.name !== agent
  ) {
    return fail(`unexpected response from ${route}`);
  }
  return String(id);
};

// Registers the agent with the admin key and issues it an operator-scoped key.
export const enrollAgent = async (opts: EnrollOptions): Promise<string> => {
  const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
  const lookup = await api(opts.url, opts.adminKey, "GET", agentRoute);
  let agentId: string;
  if (lookup.status === HTTP_NOT_FOUND) {
    const registerRoute = "/api/agents/register";
    const reg = checked<AgentResponse>(
      "POST",
      registerRoute,
      await api(opts.url, opts.adminKey, "POST", registerRoute, {
        framework: opts.framework,
        name: opts.agent,
      })
    );
    agentId = agentIdOf(reg, opts.agent, registerRoute);
    log(`agent "${opts.agent}" registered (id ${printable(agentId)})`);
  } else {
    const existing = checked<AgentResponse>("GET", agentRoute, lookup);
    if (!(await opts.allowExisting())) {
      fail(
        `agent "${opts.agent}" already exists; not issuing it another key${opts.existingHint}`
      );
    }
    // not registered again: that would reset a working agent's status to idle
    agentId = agentIdOf(existing, opts.agent, agentRoute);
    log(`agent "${opts.agent}" exists (id ${printable(agentId)})`);
  }

  // operator is the lowest role that can connect, heartbeat, poll the queue and update tasks
  const keysRoute = `/api/agents/${encodeURIComponent(agentId)}/keys`;
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
  const expires = new Date(Date.now() + opts.expiresDays * DAY_MS);
  // logged first, so a key refused below can still be found and revoked by its id
  log(
    `issued key ${printable(issued.key?.key_prefix ?? "")}… (id ${printable(issued.key?.id ?? "?")}), expires on ${expires.toISOString().slice(0, 10)}; issue a new one before then`
  );
  // it is printed into shell export lines and saved as a header value
  checkKey(issued.api_key, "issued key");
  return issued.api_key;
};

// Checks that the key is an agent key of this agent: Mission Control rejects an
// agent key whose agent differs from x-agent-name, and only an admin key can list
// an agent's keys.
export const verifyKey = async (url: string, key: string, agent: string) => {
  const route = `/api/agents/${encodeURIComponent(agent)}`;
  const result = await api(url, key, "GET", route, undefined, agent);
  if (result.status === HTTP_NOT_FOUND) {
    fail(
      `Mission Control has no agent "${agent}"; an agent key belongs to an existing agent, check the name`
    );
  }
  checked("GET", route, result);
  // fails closed: only a refusal proves the key can't list keys, i.e. is not admin
  const keysRoute = `${route}/keys`;
  const asAdmin = await api(url, key, "GET", keysRoute);
  if (asAdmin.ok) {
    fail(
      "this is an admin key; give the agent an agent-scoped key (answer yes to issuing a new key)"
    );
  }
  if (
    asAdmin.status !== HTTP_UNAUTHORIZED &&
    asAdmin.status !== HTTP_FORBIDDEN
  ) {
    fail(
      `could not check that this is not an admin key: GET ${keysRoute} answered HTTP ${asAdmin.status}`
    );
  }
  log(`key accepted for agent "${agent}"`);
};
