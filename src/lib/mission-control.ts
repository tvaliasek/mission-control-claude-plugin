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
// Control, format (bidi, zero-width, tag) and line/paragraph separator characters:
// server text must not drive the terminal or change what it shows
const CONTROL_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

// Text from the server, made safe to print.
// only primitives: String() runs an object's own toString, which a server controls
const printable = (value: unknown) =>
  (typeof value === "object" && value !== null
    ? "?"
    : String(value)
  ).replaceAll(CONTROL_CHARS_RE, "?");

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

// One request; a network failure comes back as a reason instead of exiting.
const send = async (
  baseUrl: string,
  apiKey: string,
  method: string,
  route: string,
  body?: unknown,
  agentName?: string
): Promise<ApiResult | string> => {
  let res: Response;
  let text: string;
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
    // inside the try: the body can still fail to arrive (reset, timeout)
    text = await res.text();
  } catch (error) {
    // fetch error messages can contain header values, so report only the cause code
    const err = (error ?? {}) as {
      name?: string;
      cause?: { code?: string; message?: string };
    };
    return err.cause?.message === "unexpected redirect"
      ? "the server answered with a redirect, which is not followed so the key goes only to this URL"
      : (err.cause?.code ?? err.name ?? "network error");
  }
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    // null, arrays and plain values carry no fields
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    // non-JSON body: keep the status only
  }
  return { data, ok: res.ok, status: res.status };
};

const api = async (...args: Parameters<typeof send>): Promise<ApiResult> => {
  const result = await send(...args);
  if (typeof result === "string") {
    return fail(`${args[2]} ${args[3]} failed: ${result}`);
  }
  return result;
};

const errorOf = (result: ApiResult) =>
  typeof result.data.error === "string"
    ? ` ${printable(result.data.error)}`
    : "";

const checked = <T>(method: string, route: string, result: ApiResult): T => {
  if (!result.ok) {
    fail(`${method} ${route} failed: HTTP ${result.status}${errorOf(result)}`);
  }
  return result.data as T;
};

interface AgentResponse {
  agent?: { id?: number | string; name?: string };
  registered?: unknown;
}

interface KeyResponse {
  api_key?: string;
  key?: { id?: number; key_prefix?: string };
}

interface KeyListResponse {
  keys?: {
    id?: unknown;
    name?: unknown;
    key_prefix?: unknown;
    expires_at?: unknown;
    revoked_at?: unknown;
    last_used_at?: unknown;
  }[];
}

export interface IssuedKey {
  apiKey: string;
  agentId: string;
  keyId: number | undefined;
  // false only for an agent the server confirmed as newly registered
  existed: boolean;
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
export const enrollAgent = async (opts: EnrollOptions): Promise<IssuedKey> => {
  const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
  const lookup = await api(opts.url, opts.adminKey, "GET", agentRoute);
  let agentId: string;
  let existed = lookup.status !== HTTP_NOT_FOUND;
  if (existed) {
    // not registered again: that would reset a working agent's status to idle
    agentId = agentIdOf(
      checked<AgentResponse>("GET", agentRoute, lookup),
      opts.agent,
      agentRoute
    );
  } else {
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
    // an existing name is answered with that agent and registered: false, e.g. when
    // another run registered it after the lookup; only an explicit true counts as new,
    // since a new agent skips both the takeover question and earlier-key revocation
    existed = reg.registered !== true;
  }
  if (existed) {
    if (!(await opts.allowExisting())) {
      fail(
        `agent "${opts.agent}" already exists; not issuing it another key${opts.existingHint}`
      );
    }
    log(`agent "${opts.agent}" exists (id ${printable(agentId)})`);
  } else {
    log(`agent "${opts.agent}" registered (id ${printable(agentId)})`);
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
  const expires = new Date(Date.now() + opts.expiresDays * DAY_MS);
  // logged first, so a key refused below can still be found and revoked by its id
  log(
    `issued key ${printable(issued.key?.key_prefix ?? "")}… (id ${printable(issued.key?.id ?? "?")}), expires on ${expires.toISOString().slice(0, 10)}; issue a new one before then`
  );
  return {
    agentId,
    // it is printed into shell export lines and saved as a header value
    apiKey: checkKey(issued.api_key, "issued key"),
    existed,
    keyId: typeof issued.key?.id === "number" ? issued.key.id : undefined,
  };
};

const dateOf = (seconds: unknown) => {
  if (typeof seconds !== "number") {
    return "never";
  }
  const date = new Date(seconds * 1000);
  // toISOString throws on a date out of range
  return Number.isNaN(date.getTime()) ? "?" : date.toISOString().slice(0, 10);
};

// Revokes the agent's other active keys, after confirm() agrees. Run it only once the
// new key is saved: other machines sharing this agent name lose access. A key that
// can't be revoked is reported and skipped, since the new key is already in use.
export const revokeOtherKeys = async (
  url: string,
  adminKey: string,
  issued: IssuedKey,
  confirm: (count: number) => Promise<boolean>
): Promise<boolean> => {
  // resolves false when a revocation that may be needed did not happen
  if (!issued.existed) {
    return true;
  }
  const { keyId } = issued;
  if (keyId === undefined) {
    log("the new key's id is unknown, so earlier keys are not revoked");
    return false;
  }
  const route = `/api/agents/${encodeURIComponent(issued.agentId)}/keys`;
  // the new key is saved already, so a failure here is only a warning
  const listed = await send(url, adminKey, "GET", route);
  if (typeof listed === "string" || !listed.ok) {
    const reason =
      typeof listed === "string"
        ? listed
        : `HTTP ${listed.status}${errorOf(listed)}`;
    log(`warning: could not list earlier keys, none revoked: ${reason}`);
    return false;
  }
  const { keys } = listed.data as KeyListResponse;
  // every entry needs a numeric id, or an active key could be skipped unnoticed
  if (
    !(
      Array.isArray(keys) &&
      keys.every(
        (key) =>
          typeof key === "object" && key !== null && typeof key.id === "number"
      )
    )
  ) {
    log("warning: unexpected answer listing earlier keys, none revoked");
    return false;
  }
  const now = Date.now() / 1000;
  const others = keys.filter(
    (key) =>
      key.id !== keyId &&
      (key.revoked_at === null || key.revoked_at === undefined) &&
      (typeof key.expires_at !== "number" || key.expires_at > now)
  );
  if (others.length === 0) {
    return true;
  }
  log(`other active keys of this agent:`);
  for (const key of others) {
    log(
      `  ${printable(key.key_prefix ?? "")}… "${printable(key.name ?? "")}" (id ${printable(key.id)}), last used ${dateOf(key.last_used_at)}`
    );
  }
  if (!(await confirm(others.length))) {
    log("earlier keys left active");
    return true;
  }
  let allRevoked = true;
  // one at a time, so the log always says which keys were revoked
  for (const key of others) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await send(url, adminKey, "DELETE", route, {
      key_id: key.id,
    });
    if (typeof result === "string" || !result.ok) {
      const reason =
        typeof result === "string"
          ? result
          : `HTTP ${result.status}${errorOf(result)}`;
      log(`warning: key id ${printable(key.id)} not revoked: ${reason}`);
      allRevoked = false;
    } else {
      log(`revoked key id ${printable(key.id)}`);
    }
  }
  return allRevoked;
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
