// pty-helper.js — Node.js subprocess that manages a PTY.
// Bun spawns this with node. Communication via stdin/stdout (binary).
//
// Protocol:
//   stdin  → data to write to PTY (or \x01{cols,rows} for resize)
//   stdout → data from PTY
//   The first argument is the working directory.

const { spawn } = require("child_process");
const { mkdirSync } = require("fs");
const { join } = require("path");

const cwd = process.argv[2] || process.cwd();
const shell = process.env.SHELL || "/bin/sh";

const fallbackHistoryDir = join(cwd, ".adiabatic");
const fallbackHistoryFile = join(fallbackHistoryDir, "terminal_history");
const fallbackShellArgs = shell.endsWith("zsh")
  ? ["-f", "-i"]
  : shell.endsWith("bash")
    ? ["--noprofile", "--norc", "-i"]
    : ["-i"];

const env = {
  ...process.env,
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
};

let term = null;
let fallback = null;

try {
  const pty = require("node-pty");
  term = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd,
    env,
  });
} catch (err) {
  try {
    mkdirSync(fallbackHistoryDir, { recursive: true });
  } catch {}
  fallback = spawn(shell, fallbackShellArgs, {
    cwd,
    env: { ...env, HISTFILE: fallbackHistoryFile },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

if (term) {
  // PTY output → stdout
  term.onData((data) => {
    try {
      process.stdout.write(data);
    } catch {}
  });

  // PTY exit → exit this process
  term.onExit(({ exitCode }) => {
    process.exit(exitCode);
  });
} else if (fallback) {
  fallback.stdout.on("data", (data) => process.stdout.write(data));
  fallback.stderr.on("data", (data) => process.stdout.write(data));
  fallback.on("exit", (code) => process.exit(code ?? 0));
}

// stdin → PTY input (or resize command)
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.startsWith("\x01")) {
    try {
      const { cols, rows } = JSON.parse(chunk.slice(1));
      if (cols && rows && term) term.resize(cols, rows);
    } catch {}
    return;
  }
  if (term) {
    term.write(chunk);
  } else if (fallback?.stdin.writable) {
    fallback.stdin.write(chunk);
  }
});

process.stdin.on("end", () => {
  if (term) term.kill();
  if (fallback) fallback.kill();
  process.exit(0);
});
