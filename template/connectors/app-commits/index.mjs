import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export default {
  async run({ guard, state, config, signal }) {
    const previous = await state.get();
    const lastSha = previous && typeof previous.lastSha === "string"
      ? previous.lastSha
      : undefined;
    const workspacePath = config && typeof config.workspacePath === "string"
      ? config.workspacePath
      : process.cwd();
    const range = lastSha ? `${lastSha}..HEAD` : "HEAD";

    let stdout = "";
    try {
      const result = await execFileAsync("git", [
        "-C",
        workspacePath,
        "log",
        "--reverse",
        "--format=%H%x00%ct%x00%an%x00%ae%x00%s",
        range,
      ], { signal });
      stdout = result.stdout;
    } catch (err) {
      if (err && typeof err === "object" && err.name === "AbortError") return;
      const stderr = err && typeof err === "object" && typeof err.stderr === "string"
        ? err.stderr
        : "";
      if (stderr.includes("does not have any commits yet") || stderr.includes("ambiguous argument 'HEAD'")) {
        return;
      }
      throw err;
    }

    let newestSha = lastSha;
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [sha, committedAt, authorName, authorEmail, subject] = line.split("\0");
      if (!sha || sha === lastSha) continue;

      await guard.writeEvent({
        type: "app.commit",
        externalId: sha,
        startedAt: Number(committedAt) * 1000,
        payload: {
          sha,
          authorName,
          authorEmail,
          subject,
        },
      });
      newestSha = sha;
    }

    if (newestSha && newestSha !== lastSha) {
      await state.set({ lastSha: newestSha });
    }
  },
};
