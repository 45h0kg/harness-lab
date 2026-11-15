// Path confinement. Every path the model sends is untrusted input.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export class SandboxError extends Error {}

// Resolve `p` against `root` and refuse anything that lands outside it,
// including through symlinks. The file may not exist yet (write_file), so the
// symlink check runs on the deepest ancestor that does exist.
export function resolveInside(root: string, p: string): string {
  if (p.includes("\0")) throw new SandboxError("path contains a NUL byte");
  const realRoot = fs.realpathSync(root);
  const lexical = path.resolve(realRoot, p);
  let existing = lexical;
  const tail: string[] = [];
  while (!fs.existsSync(existing)) {
    tail.unshift(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const real = path.join(fs.realpathSync(existing), ...tail);
  const rel = path.relative(realRoot, real);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new SandboxError(`path escapes the workspace: ${p}`);
  }
  return real;
}

// The lab's guard for every safe-runner command (added 2026-11-15 after an agent ran
// `killall node` and stopped every Node process on the host, the bench included): a
// command may signal its own process group, nothing else. Files are not restricted.
export function signalGuardProfile(): string {
  const text = "(version 1)\n(allow default)\n(deny signal (target others))\n";
  const f = path.join(fs.realpathSync("/private/tmp"), "harness-sb-signals.sb");
  if (!fs.existsSync(f) || fs.readFileSync(f, "utf8") !== text) fs.writeFileSync(f, text);
  return f;
}

// An OS-level boundary for shell commands on macOS (Seatbelt, via sandbox-exec):
// writes only inside the workspace and the temp directories, and no reading file
// contents anywhere in the home directory outside the workspace (git's own config
// excepted). Metadata stays readable, because Node walks parent directories.
export function seatbeltProfile(root: string): string {
  const w = fs.realpathSync(root);
  const home = fs.realpathSync(process.env.HOME ?? "/Users");
  const q = (s: string) => JSON.stringify(s);
  const text = `(version 1)
(allow default)
(deny signal (target others))
(deny file-write* (require-not (require-any (subpath ${q(w)}) (subpath "/private/var/folders") (subpath "/private/tmp") (literal "/dev/null") (literal "/dev/tty"))))
(deny file-read-data (require-all (subpath ${q(home)}) (require-not (subpath ${q(w)})) (require-not (literal ${q(home + "/.gitconfig")})) (require-not (subpath ${q(home + "/.config/git")}))))
`;
  const f = path.join(fs.realpathSync("/private/tmp"), `harness-sb-${crypto.createHash("sha256").update(text).digest("hex").slice(0, 12)}.sb`);
  if (!fs.existsSync(f)) fs.writeFileSync(f, text);
  return f;
}

// Environment for child processes: an allowlist, never the parent's env.
// API keys, cloud credentials and SSH agent sockets stay out of reach.
export function childEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  env.PAGER = "cat";
  env.GIT_PAGER = "cat";
  env.GIT_TERMINAL_PROMPT = "0";
  env.CI = "1";
  return env;
}
