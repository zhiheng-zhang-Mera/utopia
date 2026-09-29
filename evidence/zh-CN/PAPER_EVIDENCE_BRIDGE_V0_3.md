# V0.3 论文证据边界

PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 65ae358809e997f2a644716ca2c0d601fb919492
FACT: GENERALIZED_PERFORMANCE_CLAIM=UNSUPPORTED
FACT: EXTERNAL_TRUTH_VERIFICATION=UNSUPPORTED

| Claim | Status | Raw evidence | Scope / limitations |
| --- | --- | --- | --- |
| C-REPAIR-01 | SUPPORTED | [regression summary](../raw/v0.3/regression-summary.json), [promotion history](../raw/v0.3/promotion-history.txt) | 普通前向提交补齐修复债务，9 条 promotion 历史仍可验证。 |
| C-BRIDGE-01 | PILOT | [windows-runs.json](../raw/v0.3/windows-runs.json) | 五个薄适配器调用所属模块。 |
| C-BRIDGE-02 | PILOT | [android-documents.json](../raw/v0.3/android-documents.json) | 两端共同权威与 canonical 结果；限本次样例及单台实机。 |
| C-BRIDGE-03 | PILOT | [regression-summary.json](../raw/v0.3/regression-summary.json) | 单元及浏览器待接入门禁通过；未观测真实未来迁移。 |
| C-BRIDGE-04 | PILOT | [android-document-errors.json](../raw/v0.3/android-document-errors.json) | 损坏输入及超大预检保留拒绝语义；不覆盖所有格式攻击。 |
| C-BRIDGE-05 | PILOT | [android-evidence-theme.json](../raw/v0.3/android-evidence-theme.json) | 篡改失败且不重算哈希；不是事实验证或强制中介。 |
| C-BRIDGE-06 | SUPPORTED | [manifest.json](../raw/v0.3/manifest.json) | 领域边界在描述符、适配器及激活审查中明确；主题所有权待审查。 |

各 claim 的运行 ID、实际源码与 APK 版本来自对应 JSON 和运行账本。原始失败不删除，修复前后证据不混为首次成功。恢复观测见 connectivity-recovery.json 和 interruption-recovery.json。摘要相等证明本次输入的 canonical 输出一致，不证明任意输入、任意设备或分布式系统全局正确。没有用单元测试替代真实 UI；未来模块门禁明确属于受控回归。
