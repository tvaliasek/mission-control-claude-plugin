const SIGINT_EXIT_CODE = 130;
const ERASE_CHAR = "\b \b";

let program = "mission-control";

export const setProgram = (name: string) => {
  program = name;
};

export const log = (message: string) => {
  process.stderr.write(`${program}: ${message}\n`);
};

export const fail = (message: string): never => {
  log(message);
  process.exit(1);
};

// For errors nobody expected: the message can contain secrets, the name can't.
export const failUnexpected = (error: unknown): never =>
  fail(
    `unexpected error: ${error instanceof Error ? error.name : typeof error}`
  );

// Characters typed or pasted after a line ending, kept for the next prompt.
let pending: string[] = [];

// Escape sequences such as arrow keys (ESC [ D) are dropped: after ESC, a [ or O
// starts a sequence that ends with a letter or ~; anything else ends it at once.
const NO_ESCAPE = 0;
const AFTER_ESC = 1;
const IN_SEQUENCE = 2;
const SEQUENCE_END_RE = /[A-Za-z~]/u;

interface LineState {
  input: string[];
  escape: number;
}

const abortInput = (
  stdin: NodeJS.ReadStream,
  code: number,
  message?: string
): never => {
  stdin.setRawMode(false);
  process.stderr.write("\n");
  if (message) {
    log(message);
  }
  process.exit(code);
};

// Applies one character; returns true when the line is complete.
const applyChar = (
  stdin: NodeJS.ReadStream,
  state: LineState,
  ch: string,
  echo: boolean
): boolean => {
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
const readLine = async (
  stdin: NodeJS.ReadStream,
  echo: boolean
): Promise<string> => {
  const state: LineState = { escape: NO_ESCAPE, input: [] };
  const consume = (chars: string[]): boolean => {
    for (let i = 0; i < chars.length; i += 1) {
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
  for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
    if (consume([...(chunk as string)])) {
      return state.input.join("");
    }
  }
  return abortInput(stdin, 1, "input ended; setup aborted");
};

const promptTerminal = async (question: string, echo: boolean) => {
  const { stdin } = process;
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.setEncoding("utf-8");
  try {
    const input = await readLine(stdin, echo);
    return input.trim();
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
    process.stderr.write("\n");
  }
};

// Reads a secret without echo. Without a terminal, the caller's environment variable
// is the only way in, so the error names it.
export const promptHidden = (question: string, envName: string) => {
  if (!process.stdin.isTTY) {
    return fail(`no terminal to prompt for a key; set ${envName} instead`);
  }
  return promptTerminal(question, false);
};

export interface Prompter {
  ask: (question: string, fallback?: string) => Promise<string>;
  confirm: (question: string, fallback: boolean) => Promise<boolean>;
}

const withDefault = (answer: string, fallback = "") =>
  answer.trim() || fallback;

// Visible questions: typed on a terminal, or taken line by line from piped input,
// which is read up front.
export const createPrompter = async (): Promise<Prompter> => {
  let read: (question: string) => Promise<string>;
  if (process.stdin.isTTY) {
    read = (question) => promptTerminal(question, true);
  } else {
    let piped = "";
    for await (const chunk of process.stdin) {
      piped += String(chunk);
    }
    const lines = piped.split(/\r?\n/u);
    read = (question) => {
      process.stderr.write(`${question}\n`);
      return Promise.resolve(lines.shift() ?? "");
    };
  }
  const ask = async (question: string, fallback?: string) =>
    withDefault(
      await read(`${question}${fallback ? ` [${fallback}]` : ""}: `),
      fallback
    );
  const confirm = async (question: string, fallback: boolean) => {
    const raw = await read(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `);
    const answer = raw.trim().toLowerCase();
    return answer ? answer.startsWith("y") : fallback;
  };
  return { ask, confirm };
};

// If stdin closes while a prompt waits, the event loop empties and Node would exit
// with 0 as if setup had succeeded. Call the returned function when the work is done.
export const guardUnfinished = () => {
  let finished = false;
  process.on("beforeExit", () => {
    if (!finished) {
      fail("input ended before setup finished");
    }
  });
  return () => {
    finished = true;
  };
};
