#!/usr/bin/env node
"use strict";
var __webpack_exports__ = {};

;// CONCATENATED MODULE: external "node:os"
const external_node_os_namespaceObject = require("node:os");
;// CONCATENATED MODULE: ./src/lib/cli.ts
const SIGINT_EXIT_CODE = 130;
const ERASE_CHAR = "\b \b";
let program = "mission-control";
const setProgram = (name)=>{
    program = name;
};
const cli_log = (message)=>{
    process.stderr.write(`${program}: ${message}\n`);
};
const cli_fail = (message)=>{
    cli_log(message);
    process.exit(1);
};
// For errors nobody expected: the message can contain secrets, the name can't.
const failUnexpected = (error)=>cli_fail(`unexpected error: ${error instanceof Error ? error.name : typeof error}`);
// Characters typed or pasted after a line ending, kept for the next prompt.
let pending = [];
// Escape sequences such as arrow keys (ESC [ D) are dropped: after ESC, a [ or O
// starts a sequence that ends with a letter or ~; anything else ends it at once.
const NO_ESCAPE = 0;
const AFTER_ESC = 1;
const IN_SEQUENCE = 2;
const SEQUENCE_END_RE = /[A-Za-z~]/u;
const abortInput = (stdin, code, message)=>{
    stdin.setRawMode(false);
    process.stderr.write("\n");
    if (message) {
        cli_log(message);
    }
    process.exit(code);
};
// Applies one character; returns true when the line is complete.
const applyChar = (stdin, state, ch, echo)=>{
    if (state.escape === AFTER_ESC) {
        state.escape = ch === "[" || ch === "O" ? IN_SEQUENCE : NO_ESCAPE;
        return false;
    }
    if (state.escape === IN_SEQUENCE) {
        state.escape = SEQUENCE_END_RE.test(ch) ? NO_ESCAPE : IN_SEQUENCE;
        return false;
    }
    if (ch === "\r" || ch === "\n") {
        return true;
    }
    if (ch === "\u0003") {
        abortInput(stdin, SIGINT_EXIT_CODE);
    }
    if (ch === "\u0004") {
        abortInput(stdin, 1, "input ended; setup aborted");
    }
    if (ch === "\u001B") {
        state.escape = AFTER_ESC;
    } else if (ch === "\u007F" || ch === "\b") {
        if (echo && state.input.length > 0) {
            process.stderr.write(ERASE_CHAR);
        }
        state.input.pop();
    } else if (ch >= " ") {
        if (echo) {
            process.stderr.write(ch);
        }
        state.input.push(ch);
    }
    return false;
};
// Reads one line from a raw-mode terminal, echoing it unless it is a secret.
// Hidden and visible questions share this reader: a readline interface in between
// left stdin in a state where the next raw read never received input.
const readLine = async (stdin, echo)=>{
    const state = {
        escape: NO_ESCAPE,
        input: []
    };
    const consume = (chars)=>{
        for(let i = 0; i < chars.length; i += 1){
            if (applyChar(stdin, state, chars[i] ?? "", echo)) {
                // the rest of a pasted secret must not reach the next, echoed prompt
                pending = echo ? chars.slice(i + 1) : [];
                return true;
            }
        }
        return false;
    };
    const leftover = pending;
    pending = [];
    if (consume(leftover)) {
        return state.input.join("");
    }
    // stdin ending (terminal closed) also ends the loop. Without destroyOnReturn: false,
    // returning early destroys stdin and Node 18 then can't leave raw mode.
    for await (const chunk of stdin.iterator({
        destroyOnReturn: false
    })){
        if (consume([
            ...chunk
        ])) {
            return state.input.join("");
        }
    }
    return abortInput(stdin, 1, "input ended; setup aborted");
};
const promptTerminal = async (question, echo)=>{
    const { stdin } = process;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf-8");
    try {
        const input = await readLine(stdin, echo);
        return input.trim();
    } finally{
        stdin.setRawMode(false);
        stdin.pause();
        process.stderr.write("\n");
    }
};
// Reads a secret without echo. Without a terminal, the caller's environment variable
// is the only way in, so the error names it.
const promptHidden = (question, envName)=>{
    if (!process.stdin.isTTY) {
        return cli_fail(`no terminal to prompt for a key; set ${envName} instead`);
    }
    return promptTerminal(question, false);
};
const withDefault = (answer, fallback = "")=>answer.trim() || fallback;
// Visible questions: typed on a terminal, or taken line by line from piped input,
// which is read up front.
const createPrompter = async ()=>{
    let read;
    if (process.stdin.isTTY) {
        read = (question)=>promptTerminal(question, true);
    } else {
        let piped = "";
        for await (const chunk of process.stdin){
            piped += String(chunk);
        }
        const lines = piped.split(/\r?\n/u);
        read = (question)=>{
            process.stderr.write(`${question}\n`);
            return Promise.resolve(lines.shift() ?? "");
        };
    }
    const ask = async (question, fallback)=>withDefault(await read(`${question}${fallback ? ` [${fallback}]` : ""}: `), fallback);
    // strict, so piped answers that are out of step fail instead of counting as yes
    const confirm = async (question, fallback)=>{
        const raw = await read(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `);
        const answer = raw.trim().toLowerCase();
        if (!answer) {
            return fallback;
        }
        if (answer !== "y" && answer !== "yes" && answer !== "n" && answer !== "no") {
            return cli_fail(`answer y or n, not "${answer}"`);
        }
        return answer.startsWith("y");
    };
    return {
        ask,
        confirm
    };
};
// If stdin closes while a prompt waits, the event loop empties and Node would exit
// with 0 as if setup had succeeded. Call the returned function when the work is done.
const guardUnfinished = ()=>{
    let finished = false;
    process.on("beforeExit", ()=>{
        if (!finished) {
            cli_fail("input ended before setup finished");
        }
    });
    return ()=>{
        finished = true;
    };
};

;// CONCATENATED MODULE: external "node:child_process"
const external_node_child_process_namespaceObject = require("node:child_process");
;// CONCATENATED MODULE: ./src/lib/clients.ts


const MARKETPLACE_REPO = "tvaliasek/mission-control-claude-plugin";
const PLUGIN_ID = "mission-control@mission-control";
// marketplace add clones a git repository, so allow for a slow network
const CLIENT_TIMEOUT_MS = 300000;
// Runs a client CLI without passing on keys from our own environment.
const run = (command, args, input)=>{
    const env = {
        ...process.env
    };
    delete env.MC_ADMIN_API_KEY;
    delete env.MC_API_KEY;
    const result = (0,external_node_child_process_namespaceObject.spawnSync)(command, args, {
        encoding: "utf-8",
        env,
        input,
        stdio: [
            "pipe",
            "pipe",
            "pipe"
        ],
        timeout: CLIENT_TIMEOUT_MS
    });
    if (result.error) {
        const { code } = result.error;
        return {
            error: `could not run ${command}: ${code ?? result.error.message}`,
            ok: false,
            output: ""
        };
    }
    const output = `${result.stdout}${result.stderr}`.trim();
    return result.status === 0 ? {
        ok: true,
        output
    } : {
        error: `${command} ${args.slice(0, 2).join(" ")} exited with ${result.status}`,
        ok: false,
        output
    };
};
const isInstalled = (command)=>run(command, [
        "--version"
    ]).ok;
const step = (result, what)=>{
    if (result.ok) {
        cli_log(what);
        return null;
    }
    return [
        result.error,
        result.output
    ].filter(Boolean).join("\n");
};
const configureClaude = (values)=>step(run("claude", [
        "plugin",
        "configure",
        PLUGIN_ID,
        "--values-stdin"
    ], JSON.stringify(values)), `configured ${PLUGIN_ID} in Claude Code`);
const installClaude = ()=>step(run("claude", [
        "plugin",
        "marketplace",
        "add",
        MARKETPLACE_REPO
    ]), "Claude Code: marketplace added") ?? step(run("claude", [
        "plugin",
        "install",
        PLUGIN_ID
    ]), "Claude Code: plugin installed");
const ALREADY_REGISTERED_RE = /already registered/u;
const installCopilot = ()=>{
    const added = run("copilot", [
        "plugin",
        "marketplace",
        "add",
        MARKETPLACE_REPO
    ]);
    // unlike claude, copilot fails when the marketplace is already registered
    const marketplace = added.ok || ALREADY_REGISTERED_RE.test(added.output) ? {
        ok: true,
        output: added.output
    } : added;
    return step(marketplace, "Copilot CLI: marketplace added") ?? step(run("copilot", [
        "plugin",
        "install",
        PLUGIN_ID
    ]), "Copilot CLI: plugin installed");
};

;// CONCATENATED MODULE: ./src/lib/mission-control.ts

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;
// Printable ASCII only: anything else is rejected by fetch with an error that echoes the value
const KEY_RE = /^[!-~]+$/u;
const TRAILING_SLASHES_RE = /\/+$/u;
const LOCAL_HOSTS = new Set([
    "localhost",
    "127.0.0.1",
    "[::1]"
]);
const REQUEST_TIMEOUT_MS = 30000;
const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const DAY_MS = 86400000;
// C0/C1 control characters (e.g. ESC) and bidi overrides: server text must not drive
// the terminal or reorder what it shows
const CONTROL_CHARS_RE = // oxlint-disable-next-line no-control-regex
/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/gu;
// Text from the server, made safe to print.
const printable = (value)=>String(value).replaceAll(CONTROL_CHARS_RE, "?");
// names that read as a number (e.g. 42, 1e3) are rejected because Mission Control
// resolves them as agent ids
const isValidAgentName = (name)=>NAME_RE.test(name) && Number.isNaN(Number(name));
const AGENT_NAME_RULES = "1-63 letters, digits, dots, hyphens or underscores, starting with a letter or digit, not a number";
const checkKey = (key, what)=>{
    if (!key) {
        cli_fail(`${what} is empty`);
    }
    if (!KEY_RE.test(key)) {
        cli_fail(`${what} contains invalid characters`);
    }
    return key;
};
// Checks the URL the user typed: absolute HTTP(S), no credentials, query or fragment.
const normalizeUrl = (value)=>{
    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch  {
        return cli_fail("Mission Control URL must be an absolute HTTP(S) URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        cli_fail("Mission Control URL must use HTTP or HTTPS");
    }
    if (parsed.username || parsed.password) {
        cli_fail("Mission Control URL must not contain credentials");
    }
    if (parsed.search || parsed.hash) {
        cli_fail("Mission Control URL must not contain a query string or fragment");
    }
    return parsed.toString().replace(TRAILING_SLASHES_RE, "");
};
const sameUrl = (a, b)=>{
    try {
        const href = (value)=>new URL(value).href.replace(TRAILING_SLASHES_RE, "");
        return href(a) === href(b);
    } catch  {
        return false;
    }
};
// A key from the environment goes only to the URL exported with it (MC_URL), so a
// key for one instance is never sent to another.
const envKey = (name, url)=>{
    const key = process.env[name]?.trim();
    if (!key) {
        return;
    }
    if (!sameUrl(process.env.MC_URL?.trim() ?? "", url)) {
        cli_log(`ignoring ${name} from the environment: MC_URL is not ${url}`);
        return;
    }
    cli_log(`using ${name} from the environment`);
    return key;
};
// Plain HTTP to another machine sends API keys unencrypted.
const isRemotePlainHttp = (url)=>{
    const parsed = new URL(url);
    return parsed.protocol === "http:" && !LOCAL_HOSTS.has(parsed.hostname);
};
const api = async (baseUrl, apiKey, method, route, body, agentName)=>{
    let res;
    try {
        res = await fetch(`${baseUrl}${route}`, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "x-api-key": apiKey,
                // makes Mission Control reject an agent key that belongs to another agent
                ...agentName ? {
                    "x-agent-name": agentName
                } : {}
            },
            method,
            // following a redirect would send the key to the redirect target
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        // fetch error messages can contain header values, so report only the cause code
        const err = error ?? {};
        const reason = err.cause?.message === "unexpected redirect" ? "the server answered with a redirect, which is not followed so the key goes only to this URL" : err.cause?.code ?? err.name ?? "network error";
        return cli_fail(`${method} ${route} failed: ${reason}`);
    }
    const text = await res.text();
    let data = {};
    try {
        data = JSON.parse(text);
    } catch  {
    // non-JSON body: keep the status only
    }
    return {
        data,
        ok: res.ok,
        status: res.status
    };
};
const checked = (method, route, result)=>{
    if (!result.ok) {
        const detail = typeof result.data.error === "string" ? ` ${printable(result.data.error)}` : "";
        cli_fail(`${method} ${route} failed: HTTP ${result.status}${detail}`);
    }
    return result.data;
};
// The agent's id, after checking the response names the agent we asked for.
const agentIdOf = (response, agent, route)=>{
    const id = response.agent?.id;
    if (typeof id !== "number" && typeof id !== "string" || response.agent?.name !== agent) {
        return cli_fail(`unexpected response from ${route}`);
    }
    return String(id);
};
// Registers the agent with the admin key and issues it an operator-scoped key.
const enrollAgent = async (opts)=>{
    const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
    const lookup = await api(opts.url, opts.adminKey, "GET", agentRoute);
    let agentId;
    if (lookup.status === HTTP_NOT_FOUND) {
        const registerRoute = "/api/agents/register";
        const reg = checked("POST", registerRoute, await api(opts.url, opts.adminKey, "POST", registerRoute, {
            framework: opts.framework,
            name: opts.agent
        }));
        agentId = agentIdOf(reg, opts.agent, registerRoute);
        cli_log(`agent "${opts.agent}" registered (id ${printable(agentId)})`);
    } else {
        const existing = checked("GET", agentRoute, lookup);
        if (!await opts.allowExisting()) {
            cli_fail(`agent "${opts.agent}" already exists; not issuing it another key${opts.existingHint}`);
        }
        // not registered again: that would reset a working agent's status to idle
        agentId = agentIdOf(existing, opts.agent, agentRoute);
        cli_log(`agent "${opts.agent}" exists (id ${printable(agentId)})`);
    }
    // operator is the lowest role that can connect, heartbeat, poll the queue and update tasks
    const keysRoute = `/api/agents/${encodeURIComponent(agentId)}/keys`;
    const issued = checked("POST", keysRoute, await api(opts.url, opts.adminKey, "POST", keysRoute, {
        expires_in_days: opts.expiresDays,
        name: opts.keyName,
        scopes: [
            "operator"
        ]
    }));
    if (!issued.api_key) {
        return cli_fail("unexpected response from the key endpoint");
    }
    // it is printed into shell export lines and saved as a header value
    checkKey(issued.api_key, "issued key");
    const expires = new Date(Date.now() + opts.expiresDays * DAY_MS);
    cli_log(`issued key ${printable(issued.key?.key_prefix ?? "")}… (id ${printable(issued.key?.id ?? "?")}), expires on ${expires.toISOString().slice(0, 10)}; issue a new one before then`);
    return issued.api_key;
};
// Checks that the key is an agent key of this agent: Mission Control rejects an
// agent key whose agent differs from x-agent-name, and only an admin key can list
// an agent's keys.
const verifyKey = async (url, key, agent)=>{
    const route = `/api/agents/${encodeURIComponent(agent)}`;
    const result = await api(url, key, "GET", route, undefined, agent);
    if (result.status === HTTP_NOT_FOUND) {
        fail(`Mission Control has no agent "${agent}"; an agent key belongs to an existing agent, check the name`);
    }
    checked("GET", route, result);
    // fails closed: only a refusal proves the key can't list keys, i.e. is not admin
    const keysRoute = `${route}/keys`;
    const asAdmin = await api(url, key, "GET", keysRoute);
    if (asAdmin.ok) {
        fail("this is an admin key; give the agent an agent-scoped key (answer yes to issuing a new key)");
    }
    if (asAdmin.status !== HTTP_UNAUTHORIZED && asAdmin.status !== HTTP_FORBIDDEN) {
        fail(`could not check that this is not an admin key: GET ${keysRoute} answered HTTP ${asAdmin.status}`);
    }
    log(`key accepted for agent "${agent}"`);
};

;// CONCATENATED MODULE: ./src/mc-enroll.ts
//
/*
 Enroll a Claude Code agent with Mission Control using an admin API key once,
 then hand the agent only an agent-scoped key.

 Usage:
   node mc-enroll.cjs --url https://mc.example.com --agent build-box [--print]

 Options:
   --url URL            Mission Control base URL (required)
   --agent NAME         Agent name to register (required)
   --key-name NAME      Label for the issued key (default: this hostname)
   --expires-days N     Key lifetime in days, 1-3650 (default: 90)
   --existing           Allow issuing a key for an agent that already exists
   --print              Print the agent key instead of configuring the local plugin
   --allow-http         Allow a plain-HTTP URL to another machine (keys unencrypted)

 The admin key is read from MC_ADMIN_API_KEY (only when MC_URL names the same URL
 as --url) or prompted for without echo.
 It is never written anywhere. Without --print, the agent key is saved with
 `claude plugin configure mission-control@mission-control --values-stdin`.

 Source: src/mc-enroll.ts in github.com/tvaliasek/mission-control-claude-plugin
*/ 



const MAX_EXPIRES_DAYS = 3650;
const DEFAULT_EXPIRES_DAYS = 90;
const parseArgs = (argv)=>{
    let url;
    let agent;
    const opts = {
        allowHttp: false,
        existing: false,
        expiresDays: DEFAULT_EXPIRES_DAYS,
        keyName: (0,external_node_os_namespaceObject.hostname)(),
        print: false
    };
    for(let i = 0; i < argv.length; i += 1){
        const arg = argv[i];
        const value = ()=>{
            const next = argv[i + 1];
            // e.g. "--key-name --print" would otherwise swallow --print
            if (next === undefined || next.startsWith("--")) {
                return cli_fail(`${arg} needs a value`);
            }
            i += 1;
            return next;
        };
        switch(arg){
            case "--url":
                {
                    url = value();
                    break;
                }
            case "--agent":
                {
                    agent = value();
                    break;
                }
            case "--key-name":
                {
                    opts.keyName = value();
                    break;
                }
            case "--expires-days":
                {
                    opts.expiresDays = Number(value());
                    break;
                }
            case "--existing":
                {
                    opts.existing = true;
                    break;
                }
            case "--print":
                {
                    opts.print = true;
                    break;
                }
            case "--allow-http":
                {
                    opts.allowHttp = true;
                    break;
                }
            case "-h":
            case "--help":
                {
                    process.stdout.write("Usage: node mc-enroll.cjs --url URL --agent NAME [--key-name NAME] [--expires-days N] [--existing] [--print] [--allow-http]\n");
                    process.exit(0);
                    break;
                }
            default:
                {
                    cli_fail(`unknown argument: ${arg}`);
                }
        }
    }
    if (!url) {
        return cli_fail("--url is required");
    }
    if (!(agent && isValidAgentName(agent))) {
        return cli_fail(`--agent is required: ${AGENT_NAME_RULES}`);
    }
    if (!Number.isInteger(opts.expiresDays) || opts.expiresDays < 1 || opts.expiresDays > MAX_EXPIRES_DAYS) {
        cli_fail(`--expires-days must be an integer between 1 and ${MAX_EXPIRES_DAYS}`);
    }
    const normalized = normalizeUrl(url);
    if (isRemotePlainHttp(normalized) && !opts.allowHttp) {
        cli_fail("plain HTTP would send API keys unencrypted; use HTTPS or pass --allow-http");
    }
    return {
        ...opts,
        agent,
        url: normalized
    };
};
const main = async ()=>{
    setProgram("mc-enroll");
    const opts = parseArgs(process.argv.slice(2));
    const adminKey = checkKey(envKey("MC_ADMIN_API_KEY", opts.url) ?? await promptHidden("Mission Control admin API key: ", "MC_ADMIN_API_KEY and MC_URL"), "admin API key");
    const agentKey = await enrollAgent({
        adminKey,
        agent: opts.agent,
        allowExisting: ()=>Promise.resolve(opts.existing),
        existingHint: "; pass --existing to issue it another key",
        expiresDays: opts.expiresDays,
        framework: "claude-code",
        keyName: opts.keyName,
        url: opts.url
    });
    if (opts.print) {
        process.stdout.write(`${agentKey}\n`);
        return;
    }
    const error = configureClaude({
        agent_name: opts.agent,
        mc_api_key: agentKey,
        mc_url: opts.url
    });
    if (error) {
        // The key exists server-side now; print it so it is not lost.
        cli_log(`${error}\nmc-enroll: configure the plugin manually with this key:`);
        process.stdout.write(`${agentKey}\n`);
        process.exitCode = 1;
        return;
    }
    cli_log(`start a new Claude Code session to use ${PLUGIN_ID}`);
};
const mc_enroll_finished = guardUnfinished();
main().then(mc_enroll_finished).catch(failUnexpected);

for(var __rspack_i in __webpack_exports__) {
  exports[__rspack_i] = __webpack_exports__[__rspack_i];
}
Object.defineProperty(exports, '__esModule', { value: true });
