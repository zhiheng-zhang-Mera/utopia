# Theme Builder D9

D9 在 `3ff7d805f0432d39499bee10741f54d3ec98f3de` 完成本地 Room 验收后，强化已有 `city/11-entertainment/01-entertainment-centre/theme-engine`。这是 D2、D6 之后的第三个孵化 Room。模块仍为 PROMOTED、产权审查待完成；D9 不将其改为 ACTIVE，也不应用全局主题。

```js
import fs from 'node:fs';
import path from 'node:path';
import {prepareDraft} from './city/11-entertainment/01-entertainment-centre/theme-engine/design/designer.mjs';
import {buildThemePackage, summarizeBuild} from './city/11-entertainment/01-entertainment-centre/theme-engine/build/builder.mjs';
const sandboxRoot = path.resolve('.runtime/theme-preview');
fs.mkdirSync(sandboxRoot, {recursive:true});
const draft = prepareDraft({prompt:'blue research compact no persona', observation:null});
const result = await buildThemePackage({draft, sandboxRoot, outDir:path.join(sandboxRoot,'new-package')});
console.log(summarizeBuild(result,draft));
```

输出目标必须是新的绝对路径，位于已存在且非链接的沙箱根目录内，父目录也必须真实存在。已有目标、路径逃逸、链接根目录／父目录及不合格包都会被拒绝。独立 staging 目录验证后才 rename；失败只清理本次 staging。成功产物由调用方控制保留期限。Builder 不选择安装目录、registry 或全局目录。

`intent(prompt)` 是确定性离线入口。`prepareDraft` 生成 token 和计划，验证观测几何，并让放置资源避开关键矩形区域。`observation:null` 时明确报告降级的保守布局。有观测时提供有限数值 `viewport:{width,height}`，可选 `safe_region:{x,y,width,height}` 和 `critical_regions:[...]`。空观测或不可用区域会被拒绝。

Generator 接受注入图像函数及有界重试／超时参数。它校验真实字节和最终处理后的像素，拒绝后重试，再程序化回退，仅禁用最终失败的可选资源。不包含模型／provider 客户端。禁用资源不能通过传入 token、legacy asset 或 persona／slot 残留引用重新出现。受控测试可注入 `draft.image_generator`；正常产品路径离线运行。

资源受尺寸／字节限制；完整产物上限为 24,000,000 字节。包包含声明式文档、真实 PNG 和预览。`summarizeBuild` 返回意图／计划／包／内容／校验 digest、判定、回退／降级及有界 PNG 预览，不暴露文件系统路径。确定性输入相同则包 digest 相同；注入的非确定性图片字节会自然改变 digest。

测试：`node city/test-all.mjs theme-engine`。孵化浏览器证据保留在 Git 和 [D9 Room 验收](../../evidence/zh-CN/D9_ROOM_ACCEPTANCE.md)。City `DONOR.json` 记录七文件映射及行为分类。真实模型 API、运行时应用、registry／lifecycle／recovery 和外部 renderer 集成仍为 DEFERRED。GLOBAL_THEME_APPLY=NO。
