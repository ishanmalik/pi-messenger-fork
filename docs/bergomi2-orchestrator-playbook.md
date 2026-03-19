# Bergomi2 Orchestrator Playbook

This is the operator checklist for keeping your session data clean for future training.

## Golden rule
Before you do anything, set the session mode:

- **Real project work** → `runType: "production"`
- **Smoke/probe/testing** → `runType: "smoke"`

---

## Daily workflow (5 commands)

### 1) Start a real work session
```typescript
pi_messenger({ action: "data.session", project: "bergomi2", runType: "production" })
```

### 2) Join + run orchestrator as usual
```typescript
pi_messenger({ action: "join" })
// then use spawn / agents.assign / send / agents.check / etc.
```

### 3) Quick data health check
```typescript
pi_messenger({ action: "data.stats" })
```

### 4) Export training corpus
```typescript
pi_messenger({
  action: "data.export",
  project: "bergomi2",
  out: ".pi/messenger/data/exports/bergomi2.jsonl"
})
```

### 5) Run retention cleanup
```typescript
pi_messenger({ action: "data.retention" })
```

---

## Smoke-test workflow (important)

Before smoke tests:
```typescript
pi_messenger({ action: "data.session", project: "bergomi2", runType: "smoke" })
```

After smoke tests:
```typescript
pi_messenger({ action: "data.session", project: "bergomi2", runType: "production" })
```

This prevents smoke data from polluting production training exports.

---

## Weekly routine

1. Run `data.stats`
2. Run `data.retention`
3. Export a dated snapshot:

```typescript
pi_messenger({
  action: "data.export",
  project: "bergomi2",
  out: ".pi/messenger/data/exports/bergomi2-YYYY-MM-DD.jsonl"
})
```

4. Back up exported JSONL externally (S3/Drive/etc.)

---

## Recovery / mistakes

### Forgot to switch to smoke mode
- Switch now:
```typescript
pi_messenger({ action: "data.session", project: "bergomi2", runType: "smoke" })
```
- Then run cleanup + re-export:
```typescript
pi_messenger({ action: "data.retention" })
pi_messenger({ action: "data.export", project: "bergomi2", out: ".pi/messenger/data/exports/bergomi2.jsonl" })
```

### Asked off-topic questions
Off-topic is excluded by policy. Verify with:
```typescript
pi_messenger({ action: "data.stats" })
```

---

## What policy does by default

- `production_work`: full storage, training included (if project is allowed)
- `smoke_test`: summary-only, excluded from training
- `off_topic`: payload dropped (metadata only), excluded from training
- `ops_debug`: summary-only, excluded from training
