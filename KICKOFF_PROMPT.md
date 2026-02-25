# Kickoff Prompt

Use this prompt to start a fresh pi session that will implement the orchestrator mode.

## Prerequisites (manual steps before launching)

1. Fork `https://github.com/nicobailon/pi-messenger` to your GitHub account (browser)
2. Clone it:
   ```bash
   cd ~/repos/pi-messenger-fork
   git init  # if not already
   git remote add origin git@github.com:<YOUR_USERNAME>/pi-messenger.git
   git pull origin main
   ```
3. Update `~/.pi/agent/settings.json` — replace `"npm:pi-messenger"` with `"/home/ishan/repos/pi-messenger-fork"` in the extensions array
4. Restart pi to verify the local extension loads

## Launch Command

```bash
cd ~/repos/pi-messenger-fork
pi --model openai-codex/gpt-5.3-codex --thinking xhigh
```

Or for Opus:
```bash
cd ~/repos/pi-messenger-fork
pi --model anthropic/claude-opus-4-6 --thinking xhigh
```

## Prompt to Paste

```
Read @ORCHESTRATOR_MODE_SPEC.md — it is the full implementation spec for adding Orchestrator Mode to this pi-messenger extension fork.

This is a Node.js/TypeScript pi extension. The codebase is already here in this directory. Start by:

1. Verify the repo is set up: check package.json, run npm install, check if it builds
2. Create branch: git checkout -b feature/orchestrator-mode
3. Install zvec: npm install @zvec/zvec
4. Read the existing source files referenced in the spec (index.ts, crew/index.ts, crew/utils/config.ts, handlers.ts, crew/lobby.ts, crew/agents.ts) to understand current patterns
5. Then implement the spec step by step, starting with Phase 2 (state, config, memory foundation)

Work through the phases in order. After each phase, commit your changes with a descriptive message. Ask me if anything in the spec is ambiguous.

Key constraints:
- Follow existing code patterns (atomic file writes, TypeBox schemas, config deepMerge, etc.)
- Don't break existing pi-messenger functionality — all current tests must pass
- This is a public fork — keep code quality high
- The zvec memory layer should degrade gracefully (never crash the extension)
```
