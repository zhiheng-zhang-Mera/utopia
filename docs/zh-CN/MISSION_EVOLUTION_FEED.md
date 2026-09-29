# Mission 自进化经验流

STATUS: BOOTSTRAP_V1
PAIR_STATUS: SYNCHRONIZED

该经验流用于记录 Digital-City Mission Book 迁移过程中产生的结构化经验，但不会把施工原始历史直接变成 Utopia 的现行规则。

## 存储模型

- `.runtime/evidence/mission-book/<MISSION_ID>/<run-id>/`：本机原始运行证据；Git 忽略。
- `data-records/evolution/inbox/mission-book/<MISSION_ID>/events.jsonl`：Mission 分支上的有界结构化跨主机交接历史。
- `data-records/evolution/episodes/mission-book/<MISSION_ID>/episode.json`：验收完成后由验证主机生成的归一化 episode。

Raw evidence 只是证据，不是 policy。Inbox 事件不是权威规则。只有 verified episode 才有资格进入未来 retrieval / self-evolution 流，而且其权限仍固定为 `EXPERIENCE_ONLY`。

## 记录事件

```bash
pnpm mission:event -- \
  --mission MB-001 \
  --role migration \
  --host Mech \
  --type TEST_FAIL \
  --outcome fail \
  --summary "Root Trust parity failed" \
  --source-ref "Codex-Boss@8df428..." \
  --target-ref "mission/MB-001-core-os" \
  --evidence ".runtime/evidence/mission-book/MB-001/migration-Mech/root-trust-fail.json"
```

允许的 event type 由 `contracts/evolution/mission-event-v1.schema.json` 固定。Mission 施工时不得自行发明新的事件标签。

## Verification 后收口

验证主机只有在完成独立审查、必要维修、真实使用验证以及 required CI 全绿后才能执行：

```bash
pnpm mission:finalize -- \
  --mission MB-001 \
  --migration-host Mech \
  --verification-host Alien \
  --branch-sha <final-branch-sha> \
  --ci-run <final-green-ci-run>
```

以下情况会拒绝 finalize：
- Migration / Verification 是同一台主机；
- 缺少 PASS `MIGRATION_COMPLETE`；
- 缺少 `VERIFIER_FINDING`；
- 最后一次验证 `CI_RESULT` 不是 PASS；
- 最终绿色 CI 之后缺少 PASS `VERIFICATION_COMPLETE`。

成功后生成 verified episode，并删除当前树中的 inbox 文件；Git 历史仍然保留施工分支上的结构化过程轨迹。

## 安全/数据规则

不得记录 credential、token、secret、设备序列号、模型私有推理或无界 terminal dump。跨主机需要共享时，只发布有界、非敏感、确有验证价值的 candidate evidence。
