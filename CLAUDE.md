# Agent OS

把飞书变成 AI 编程 CLI（Claude Code / Codex）的指挥台。
一个话题 = 一个任务；bot 之间可互相 @ 协作；cron 定时巡检。

## 运行

pnpm start（watch 模式）/ pnpm start:once（单次启动）

## 约定

- ESM only，Node 22+，pnpm
- 凭证只放 .env（已 gitignore），绝不硬编码、绝不提交

## Linting and formatting

- After making code changes, run `pnpm run lint:fix`, then run `pnpm run fmt`.
- Before finishing, run `pnpm run lint -- --deny-warnings --format=agent`.

## Commit convention

This repository enforces its commit convention with commitlint.

- Read the rules before committing: `pnpm commitlint --print-config json`
- Validate a message before using it: `printf '%s' "<message>" | pnpm commitlint`
  (exit 0 = valid)
- If the commit-msg hook rejects a commit, fix the rules named in brackets
  (e.g. `[subject-case]`) and retry. Never use `git commit --no-verify`.

## 错题本

> 踩坑后追加一行：现象 → 原因 → 正确做法。给未来的 AI 和人看。
