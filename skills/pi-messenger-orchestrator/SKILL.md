---
name: pi-messenger-orchestrator
description: Spawn, manage, and coordinate persistent worker agents with shared memory. Use when orchestrating multi-agent workflows with ongoing guidance.
---

# Pi-Messenger Orchestrator Skill

Spawn persistent worker agents, assign tasks, communicate via DM, and manage lifecycle.

## Quick Start

### 1. Join the Mesh (Required)
```typescript
pi_messenger({ action: "join" })
```

### 2. Spawn a Worker
```typescript
pi_messenger({ action: "spawn", model: "openai-codex/gpt-5.3-codex", name: "Builder", thinking: "xhigh" })
```

### 3. Assign a Task
```typescript
pi_messenger({ action: "agents.assign", name: "Builder", task: "Implement Redis caching in src/cache.py" })
```

### 4. Communicate and Monitor
```typescript
pi_messenger({ action: "send", to: "Builder", message: "Use TTL-based invalidation" })
pi_messenger({ action: "agents.check", name: "Builder" })
pi_messenger({ action: "agents.logs", name: "Builder" })
pi_messenger({ action: "agents.list" })
```

### 5. Lifecycle
```typescript
pi_messenger({ action: "agents.kill", name: "Builder" })
pi_messenger({ action: "agents.killall" })
pi_messenger({ action: "agents.attach", name: "Builder" })
```

### 6. Memory
```typescript
pi_messenger({ action: "agents.memory.stats" })
pi_messenger({ action: "agents.memory.reset" })
```

## Worker Completion Signal

Spawned agents should call:
```typescript
pi_messenger({ action: "agents.done", summary: "Brief description of what was accomplished" })
```

If `autoKillOnDone` is enabled, the agent is automatically terminated after reporting done.
