# harness-lab

The code behind the [Harness Engineering](https://ashokg.ai/harness/) track: a coding agent's harness built from nothing, one piece per chapter, and the bench that measured each piece on two small local models.

A **harness** is the program around a language model that turns it into an agent: the loop that calls the model, the tools it can use, the errors it gets back, what stays in its context, what it's allowed to touch, and what happens when something crashes. The chapters explain each piece in detail; this repository is the code they walk through.

## What's here

| Chapter | Piece | Files |
| --- | --- | --- |
| 1 | The smallest agent: one shell tool and a loop | `src/bare.ts`, `src/agent.ts` |
| 2 | Evaluation: tasks with hidden checks, the bench, the oracle | `src/tasks.ts`, `src/bench.ts`, `src/oracle.ts`, `src/report.ts` |
| 3 | The wire: chat templates and parsing tool calls | `src/ollama.ts`, `src/raw.ts`, `src/probe-wire.ts` |
| 4 | The system prompt | `src/harness.ts` |
| 5 | Stopping: stop reasons, nudges, the stop check, the repeat guard | `src/loop.ts`, `src/stopcheck.ts` |
| 6–10 | File tools, instructive errors, output limits, safe edits, process control | `src/toolkit.ts`, `src/survived.ts`, `src/demo-runners.ts` |
| 11 | The box: path confinement, a macOS sandbox profile, a clean environment | `src/sandbox.ts`, `src/box-check.ts`, `src/symlink-check.ts` |
| 12 | Permissions | `src/permissions.ts`, `src/replay-policy.ts` |
| 13 | Untrusted text | `src/harness.ts` (the prompt), `src/scenarios.ts` |
| 14 | The context window: compaction | `src/loop.ts`, `src/probe-overflow.mjs` |
| 15 | The prefix: prompt caching | `src/loop.ts`, `src/raw.ts` |
| 16 | Crash recovery: the session log | `src/transcript.ts` |
| 17 | The same harness on Claude | `src/model.ts`, `src/metered-claude.ts`, `src/main.ts` |

Every chapter's agent is a named configuration in `src/variants.ts`, so the same bench can run any step of the track. `fixtures/shelf` is the small JavaScript project every task starts from.

`runs/` holds only the few small outputs the chapters cite as evidence. The full run records (transcripts, session logs, workspaces) aren't included: they're large and full of local paths. Run the bench to make your own.

## Requirements

- **macOS.** From chapter 10 on, the shell tool runs every command under `sandbox-exec`. On Linux you'd replace that with your own sandbox; everything else is plain Node.js.
- **Node.js 23** or later.
- **[Ollama](https://ollama.com)** with `qwen2.5:7b` and `llama3.1:8b` pulled, for the bench. The scenarios and checks below need no model.

```sh
npm install
```

## Without a model

```sh
npx tsx src/scenarios.ts      # the real loop, tools, policy and session log, driven by a scripted model
npx tsx src/oracle.ts         # each task's hidden check fails before and passes after a known-good fix
npx tsx src/box-check.ts      # what each boundary in chapter 11 does with the same four calls
npx tsc -p .                  # type-check everything
```

## With Ollama

One agent, one model, one task, one run:

```sh
npx tsx src/bench.ts --exp try --agent stale-on --model qwen2.5:7b --wire raw --runs 1 --tasks rename
npx tsx src/report.ts runs/try
```

`--agent` is any name in `src/variants.ts`. `--wire raw` uses the harness's own chat template and parser (chapter 3); leave it out to use Ollama's. Each run gets a fresh copy of `shelf` under `runs/<exp>/`, with the session log written as it goes and a transcript at the end.

To re-run a chapter's experiments (slow: hours on a laptop, and hard on its fans):

```sh
sh scripts/reproduce.sh ch09
```

Small models are noisy. Your pass rates won't match the chapters' exactly, and with three runs a cell, the differences between agents are often within that noise; the chapters say where.

## With Claude

Chapter 17 is a guide to running the same harness against Claude with your own API key. `src/metered-claude.ts` is an adapter with a spending limit; it type-checks against this code but hasn't been run by the author. Keep your key out of this directory and out of any prompt, and read the chapter before spending anything.

## Safety

The agents run shell commands that a language model wrote, as you, on your machine. From chapter 10 on, the shell tool runs every command in its own process group under a macOS sandbox profile that stops it signalling other processes, and the `box-os` agent also confines file writes and home-folder reads. The earlier agents' shell runs commands as they are, and no agent but `box-os` is confined: they can read and write anything you can. Run them on a machine and account you don't mind them touching.

## License

ISC. See `LICENSE`.
