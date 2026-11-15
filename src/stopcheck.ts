// A stop check for this project: before the agent finishes, look at the
// workspace and tell the model what the harness sees. It reports facts and
// blocks nothing; the model decides what to do with them.
import { execFileSync } from "node:child_process";
import { nodeTest } from "./tasks.js";

export async function workspaceCheck(root: string): Promise<string | void> {
  const changed = execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim();
  const t = nodeTest(root);
  const problems: string[] = [];
  if (!changed) problems.push("No file in the project has changed (git status is clean).");
  if (!t.ok) problems.push(`npm test fails. The end of its output:\n${t.out.trim().split("\n").slice(-25).join("\n")}`);
  if (!problems.length) return;
  return `Before you finish, the harness checked the project:\n${problems.join("\n")}\n` +
    "If the task needs changes to files, make them with the tools now. If no change is needed (for example the task was a question), reply again with your final answer.";
}
