// Run ordinary commands, and a read and a write outside the workspace, under the final seatbeltProfile.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { seatbeltProfile, childEnv } from "../../src/sandbox.ts";
const w = path.resolve(import.meta.dirname, "work");
const prof = seatbeltProfile(w);
for (const c of ["npm test 2>&1 | tail -4", "node -e 'console.log(1+1)'", "git status --short | head -3; echo git-exit=$?", "cat ~/.zshrc >/dev/null; echo cat-home-exit=$?", "echo x > ../outside-write.txt; echo write-outside-exit=$?"]) {
  const r = spawnSync("/usr/bin/sandbox-exec", ["-f", prof, "/bin/sh", "-c", c], { cwd: w, env: childEnv(), encoding: "utf8", timeout: 60000 });
  console.log(`$ ${c}\n${(r.stdout + r.stderr).trim()}\n`);
}
