// pty-helper.js — Node.js subprocess that manages a PTY.
// Bun spawns this with node. Communication via stdin/stdout (binary).
//
// Protocol:
//   stdin  → data to write to PTY (or \x01{cols,rows} for resize)
//   stdout → data from PTY
//   The first argument is the working directory.

const pty = require("node-pty");

const cwd = process.argv[2] || process.cwd();
const shell = process.env.SHELL || "/bin/sh";

const term = pty.spawn(shell, [], {
  name: "xterm-256color",
  cols: 80,
  rows: 24,
  cwd,
  env: {
    ...process.env,
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
  },
});

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

// stdin → PTY input (or resize command)
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.startsWith("\x01")) {
    try {
      const { cols, rows } = JSON.parse(chunk.slice(1));
      if (cols && rows) term.resize(cols, rows);
    } catch {}
    return;
  }
  term.write(chunk);
});

process.stdin.on("end", () => {
  term.kill();
  process.exit(0);
});
