#!/bin/sh
# Re-run a chapter's experiments on your own machine: sh scripts/reproduce.sh ch05
# Needs Ollama running with qwen2.5:7b and llama3.1:8b pulled. Each run takes from
# seconds to ten minutes; a whole chapter can take hours on a laptop.
# Results go to runs/<experiment>/; summarize them with: npx tsx src/report.ts runs/<experiment>
set -e
b() { npx tsx src/bench.ts "$@"; }
M="qwen2.5:7b llama3.1:8b"
case "$1" in
  ch01) for m in $M; do b --exp ch01-bare --agent bare --model $m --runs 3; done ;;
  ch03) for m in $M; do for v in bare prompt; do b --exp ch03-wire --agent $v --model $m --wire raw --runs 3; done; done
        for m in $M; do b --exp ch03-wire --agent prompt --model $m --runs 3; done ;;
  ch04) for m in $M; do for v in base prompt; do b --exp ch04-prompt --agent $v --model $m --wire raw --runs 3; done; done ;;
  ch05) for m in $M; do for v in loop verify; do b --exp ch05-loop --agent $v --model $m --wire raw --runs 3; done; done ;;
  ch06) for m in $M; do b --exp ch06-tools --agent tools --model $m --wire raw --runs 3
          for v in tools tools-all; do b --exp ch06-rename --agent $v --model $m --wire raw --runs 6 --tasks rename; done; done ;;
  ch07) for m in $M; do b --exp ch07-errors --agent errors --model $m --wire raw --runs 3; done ;;
  ch08) for m in $M; do for v in errors clip-head clip; do b --exp ch08-output --agent $v --model $m --wire raw --runs 6 --tasks noisy-tests; done; done ;;
  ch09) for m in $M; do for v in stale-off stale-on; do b --exp ch09-stale --agent $v --model $m --wire raw --runs 3 --tasks add-coupon,rename,free-shipping; done; done ;;
  ch10) for m in $M; do for v in shell-naive shell-safe; do b --exp ch10-shell --agent $v --model $m --wire raw --runs 6 --tasks health; done; done ;;
  ch11) for v in box-off box-files box-os; do b --exp ch11-box --agent $v --model qwen2.5:7b --wire raw --runs 3 --tasks shared-rate,release-notes; done ;;
  ch12) for v in perm-open perm-rules; do b --exp ch12-perm --agent $v --model qwen2.5:7b --wire raw --runs 3 --tasks cleanup; done ;;
  *) echo "usage: sh scripts/reproduce.sh ch01|ch03|...|ch12"; exit 2 ;;
esac
