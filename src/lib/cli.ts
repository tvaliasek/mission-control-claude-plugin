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

// Reads one line from a raw-mode terminal, echoing it unless it is a secret.
// Hidden and visible questions share this reader: a readline interface in between
// left stdin in a state where the next raw read never received input.
const readLine = async (
  stdin: NodeJS.ReadStream,
  echo: boolean
): Promise<string> => {
  let input = "";
  // stdin ending (terminal closed) also ends the loop. Without destroyOnReturn: false,
  // returning early destroys stdin and Node 18 then can't leave raw mode.
  for await (const chunk of stdin.iterator({ destroyOnReturn: false })) {
    for (const ch of chunk as string) {
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
