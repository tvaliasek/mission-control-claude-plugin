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
const fail = (message)=>{
    cli_log(message);
    process.exit(1);
};
// Reads one line from a raw-mode terminal, echoing it unless it is a secret.
// Hidden and visible questions share this reader: a readline interface in between
// left stdin in a state where the next raw read never received input.
const readLine = async (stdin, echo)=>{
    let input = "";
    // stdin ending (terminal closed) also ends the loop. Without destroyOnReturn: false,
    // returning early destroys stdin and Node 18 then can't leave raw mode.
    for await (const chunk of stdin.iterator({
        destroyOnReturn: false
    })){
        for (const ch of chunk){
            if (ch === "\r" || ch === "\n" || ch === "\u0004") {
                return input;
            }
            if (ch === "\u0003") {
                stdin.setRawMode(false);
                process.stderr.write("\n");
                process.exit(SIGINT_EXIT_CODE);
            }
            if (ch === "\u007F" || ch === "\b") {
                if (echo && input) {
                    process.stderr.write(ERASE_CHAR);
                }
                input = input.slice(0, -1);
            } else if (ch >= " ") {
                if (echo) {
                    process.stderr.write(ch);
                }
                input += ch;
            }
        }
    }
    return input;
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
        return fail(`no terminal to prompt for a key; set ${envName} instead`);
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
    const confirm = async (question, fallback)=>{
        const raw = await read(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `);
        const answer = raw.trim().toLowerCase();
        return answer ? answer.startsWith("y") : fallback;
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
            fail("input ended before setup finished");
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
        ]
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
const DIGITS_RE = /^\d+$/u;
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
// all-digit names are rejected because Mission Control resolves them as agent ids
const isValidAgentName = (name)=>NAME_RE.test(name) && !DIGITS_RE.test(name);
const AGENT_NAME_RULES = "1-63 letters, digits, dots, hyphens or underscores, starting with a letter or digit, not only digits";
const checkKey = (key, what)=>{
    if (!key) {
        fail(`${what} is empty`);
    }
    if (!KEY_RE.test(key)) {
        fail(`${what} contains invalid characters`);
    }
    return key;
};
// Same rules as the bundled mc-base-url.cjs, inlined so each built script stands alone.
const normalizeUrl = (value)=>{
    let parsed;
    try {
        parsed = new URL(value.trim());
    } catch  {
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
        cli_log("warning: plain HTTP sends API keys unencrypted");
    }
    return parsed.toString().replace(TRAILING_SLASHES_RE, "");
};
const api = async (baseUrl, apiKey, method, route, body)=>{
    let res;
    try {
        res = await fetch(`${baseUrl}${route}`, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: {
                Accept: "application/json",
                "Content-Type": "application/json",
                "x-api-key": apiKey
            },
            method,
            // following a redirect would send the key to the redirect target
            redirect: "error",
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        // fetch error messages can contain header values, so report only the cause code
        const err = error ?? {};
        return fail(`${method} ${route} failed: ${err.cause?.code ?? err.name ?? "network error"} (redirects are not followed)`);
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
        const detail = typeof result.data.error === "string" ? ` ${result.data.error}` : "";
        fail(`${method} ${route} failed: HTTP ${result.status}${detail}`);
    }
    return result.data;
};
// Registers the agent with the admin key and issues it an operator-scoped key.
const enrollAgent = async (opts)=>{
    // look up first: registering an existing agent would reset its status to idle
    const agentRoute = `/api/agents/${encodeURIComponent(opts.agent)}`;
    const lookup = await api(opts.url, opts.adminKey, "GET", agentRoute);
    if (lookup.status !== HTTP_NOT_FOUND) {
        checked("GET", agentRoute, lookup);
        if (!await opts.allowExisting()) {
            fail(`agent "${opts.agent}" already exists; not issuing it another key`);
        }
    }
    const registerRoute = "/api/agents/register";
    const reg = checked("POST", registerRoute, await api(opts.url, opts.adminKey, "POST", registerRoute, {
        framework: opts.framework,
        name: opts.agent
    }));
    const agentId = reg.agent?.id;
    if (agentId === undefined || agentId === null) {
        fail(`unexpected response from ${registerRoute}`);
    }
    cli_log(`agent "${reg.agent?.name}" ${reg.registered ? "registered" : "exists"} (id ${agentId})`);
    // operator is the lowest role that can connect, heartbeat, poll the queue and update tasks
    const keysRoute = `/api/agents/${agentId}/keys`;
    const issued = checked("POST", keysRoute, await api(opts.url, opts.adminKey, "POST", keysRoute, {
        expires_in_days: opts.expiresDays,
        name: opts.keyName,
        scopes: [
            "operator"
        ]
    }));
    if (!issued.api_key) {
        return fail("unexpected response from the key endpoint");
    }
    cli_log(`issued key ${issued.key?.key_prefix ?? ""}… (id ${issued.key?.id ?? "?"}), expires in ${opts.expiresDays} days`);
    return issued.api_key;
};
// Checks that Mission Control accepts the key, using a read-only request.
const verifyKey = async (url, key, agent)=>{
    const route = `/api/agents/${encodeURIComponent(agent)}`;
    const result = await api(url, key, "GET", route);
    if (result.status === HTTP_NOT_FOUND) {
        log(`warning: Mission Control accepted the key but has no agent "${agent}" yet; it is created on first connect`);
        return;
    }
    checked("GET", route, result);
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

 The admin key is read from MC_ADMIN_API_KEY or prompted for without echo.
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
        existing: false,
        expiresDays: DEFAULT_EXPIRES_DAYS,
        keyName: (0,external_node_os_namespaceObject.hostname)(),
        print: false
    };
    for(let i = 0; i < argv.length; i += 1){
        const arg = argv[i];
        const value = ()=>{
            const next = argv[i + 1];
            if (next === undefined) {
                return fail(`${arg} needs a value`);
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
            case "-h":
            case "--help":
                {
                    process.stdout.write("Usage: node mc-enroll.cjs --url URL --agent NAME [--key-name NAME] [--expires-days N] [--existing] [--print]\n");
                    process.exit(0);
                    break;
                }
            default:
                {
                    fail(`unknown argument: ${arg}`);
                }
        }
    }
    if (!url) {
        return fail("--url is required");
    }
    if (!(agent && isValidAgentName(agent))) {
        return fail(`--agent is required: ${AGENT_NAME_RULES}`);
    }
    if (!Number.isInteger(opts.expiresDays) || opts.expiresDays < 1 || opts.expiresDays > MAX_EXPIRES_DAYS) {
        fail(`--expires-days must be an integer between 1 and ${MAX_EXPIRES_DAYS}`);
    }
    return {
        ...opts,
        agent,
        url: normalizeUrl(url)
    };
};
const main = async ()=>{
    setProgram("mc-enroll");
    const opts = parseArgs(process.argv.slice(2));
    const adminKey = checkKey(process.env.MC_ADMIN_API_KEY?.trim() || await promptHidden("Mission Control admin API key: ", "MC_ADMIN_API_KEY"), "admin API key");
    const agentKey = await enrollAgent({
        adminKey,
        agent: opts.agent,
        allowExisting: ()=>Promise.resolve(opts.existing),
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
main().then(mc_enroll_finished).catch(()=>fail("unexpected error"));

for(var __rspack_i in __webpack_exports__) {
  exports[__rspack_i] = __webpack_exports__[__rspack_i];
}
Object.defineProperty(exports, '__esModule', { value: true });
