// pty-helper.js — Node.js subprocess that manages a PTY.
// Bun spawns this with node. Communication via stdin/stdout (binary).
//
// Protocol:
//   stdin  → data to write to PTY (or \x01{cols,rows} for resize)
//   stdout → data from PTY
//   The first argument is the working directory.

const { spawn } = require("child_process");

const cwd = process.argv[2] || process.cwd();
const shell = process.env.SHELL || "/bin/sh";

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
  process.stdout.write("\x1b[33m~ PTY unavailable; using shell pipe fallback ~\x1b[0m\r\n");
  fallback = spawn(shell, ["-i"], {
    cwd,
    env,
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
