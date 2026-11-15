# dsh-windows-notify

给 DSH 加上 **Windows 桌面通知 + 分场景提示音 + 点击跳回对话**：对话完成、出错、等待你审批、等待你确认（计划评审）、等待你回答、需要登录账号，各自弹出通知卡片并播放**互不相同**的提示音；**点卡片上那行「点击跳转到该对话」，DSH 窗口被拉到前台并直接打开那条对话**。

> 通知卡片是插件自绘的（右下角、深色卡片、彩色强调条 + 圆角徽标），弹出时**不抢焦点**：不会把你正在打字的窗口切走。卡片上只有两处可点：提示那一行（跳转）和右上角的 ✕（关闭），**其余部分点了没有任何反应** —— 想选中卡片上的文字、或者只是随手点一下，都不会把你带走。
>
> 卡片用 Windows 的「工具窗口」样式（`WS_EX_TOOLWINDOW`），因此**不会出现在 Alt+Tab（窗口切换）列表和任务栏里**，只在右下角待着。

---

## 点击跳转对话

卡片属于某条对话时（除「需要登录账号」外都有），卡片上会多一行提示「点击跳转到该对话」，那一行是手型光标、悬停会变亮。点击后：

1. 把 DSH 窗口恢复并**切到前台**（弹窗进程此刻持有前台权限，才能合法激活别人的窗口）；
2. 向 `~/.dsh/windows-notify/focus.json` 写一条跳转请求；
3. 关闭卡片；
4. 宿主看到请求后经 **SSE** 推给浏览器半，页面调用 DSH 自己的 `uiWorkspace.openSession(sessionId)` 打开那条对话。

只有这一行会跳转：卡片的标题、正文、以及它们周围的空白都是惰性的（点击不会跳转、也不会关闭）。**关闭卡片请点右上角的 ✕**（悬停同样会变亮），或者等自动消失计时到点。

这条链路刻意分成两段：**点击发生在独立弹窗进程里**，它既没有会话状态也不需要知道宿主端口，所以用文件当请求；**导航只能发生在页面里**，所以宿主用一条常驻事件流把请求转给页面。多个 GUI 窗口时只有**可见的那个**会跳（最小化的窗口不会在背后偷偷切页面）。

---

## 安装（本地插件）

1. 打开 DSH 的**插件管理**页面。
2. 在「安装」输入框里填这个**绝对路径**，然后安装：

   ```
   E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify
   ```

   插件管理器会调用 pnpm 安装它，并因为本包声明了 `dsh.bundle.patch` 而自动把它加入 profile 的 bundles 列表（无需手改 `package.json`）。
3. 安装完成后在插件列表里**启用** `dsh-windows-notify`，然后重启 DSH（或按插件页提示重载）。
4. 打开 **设置 → Windows 通知**，点每一项的「测试」按钮验证外观与提示音。

要求：Windows 10/11 + Windows PowerShell 5.1（系统自带，无需额外安装）。macOS / Linux 上插件会加载但不弹窗。

> ⚠️ 安装后请确认 profile 里是指向本目录的**链接**而不是副本，否则改代码不生效（见文末排错）。

---

## 六种通知

卡片标题是 **「提示类型 · 对话名」**（对话名取 DSH 的会话标题；还没生成标题时退化为会话 id 前 8 位），正文是具体情况（工具名与理由、错误摘要、问题内容等）——**不再显示 session id 与工作区路径**。

| 场景 | 触发点 | 默认提示音 |
|---|---|---|
| 对话完成 | 一轮回复结束、Agent 回到空闲（会话日志最后一条是 `turn/end`） | `complete`（柔和提示） |
| 出错 | `agent/error` / `api-session/error`（模型请求或本轮失败），正文带错误摘要 | `error`（低沉警报） |
| 等待审批 | `approval/request`（工具操作需要你批准），正文带工具名与理由 | `approval`（日历铃） |
| 等待确认：计划评审 | `user-questions/request` 且问题带 `intent.kind = 'plan-review'`（退出计划模式的确认） | `confirm`（轻推） |
| 等待回答：向你提问 | 其余 `user-questions/request`（`ask_user_question`），多个问题时标注总数 | `question`（邮件提示） |
| 需要登录账号 | `deepseek-account/model-sign-in-required` | `login`（邻近提示） |

设置页每一项都可以单独**开关**、单独**换提示音**（插件自带 6 种 + 17 种系统音效 + 静音），并可以**试听**（只出声、不弹卡片）和**测试**（真弹一条卡片，看外观听声音）。

### 卡片堆叠与「不消失」

默认的**提示持续时间是不消失**：卡片一直留在右下角，点提示行跳转、点 ✕ 关闭。因为这样卡片会越积越多，插件按**会话**给卡片分槽位：

- 不同会话各占一层，**向上堆叠**，不会互相遮挡；
- 同一会话的新通知**替换**自己上一层（不会堆出一列旧通知）；
- **下层消失后，上面的卡片会自己落下来补位**（不会在半空留一个洞）。位置每 900ms 按「我下面还有几张活着的卡片」重算一次，所以无论下层是被 ✕ 关掉、自动消失到期，还是进程被强杀（留下一个没有活进程的槽位文件），上层都会塌陷到贴底；
- 会话的弹窗进程异常退出后，槽位会被自动回收；
- 把滑块往左调成 N 秒，卡片就会在 N 秒后自动消失。

### 卡片不会出现在 Alt+Tab / 任务栏

卡片是 Windows 的**工具窗口**（`WS_EX_TOOLWINDOW` + 清掉 `WS_EX_APPWINDOW`），并在上屏后额外调用 `ITaskbarList::DeleteTab` 把 shell 已经登记的条目摘掉——只设样式有时会留下「已经登记过」的切换器条目。

旧版本弹出的卡片没有这个样式（而默认又不消失，所以它们会一直挂着），因此**插件启动时会自动「收养」屏幕上已有的卡片**：给它们补上工具窗口样式并摘掉切换器条目，而**不会**把它们关掉。收养脚本是 [`scripts/card-windows.ps1`](DSH-Homemade-Plugins/dsh-windows-notify/scripts/card-windows.ps1)（`-Action Adopt`；测试用 `-Action Close`）。

### 防刷屏

- **完成**：同一会话同一轮只报一次（按会话日志的 `turn/end` 序号去重），且只有本进程真正看着它跑起来过的会话才算数——新建的空会话、重放的历史日志、被丢弃的空转都不会误报。
- **出错**：同一会话 30 秒内只报一次（模型会为每次重试都发一次错误事件）。
- **等待类**：审批 / 评审 / 提问 / 登录各自 45–60 秒冷却。
- **子代理**：默认**不通知**（子任务一轮里可能完成很多次）。需要在设置页打开「子代理也通知」。

---

## 为什么不用 WinRT toast

原生 toast 是首选方案，但在这套部署上不可用，实测结论：

1. `ToastNotificationManager.Show()` **会返回成功**，通知平台事件日志也记录 `Toast ... is being delivered to ... on session 1`，`History.GetHistory()` 甚至能读回全部内容；
2. 但只有系统**已注册**的 AppUserModelID 才会真正渲染到横幅/通知中心（`Microsoft.Windows.Explorer` 能显示，插件自建的 AUMID 即使通过开始菜单快捷方式注册了 `System.AppUserModel.ID`，也**不会**在 `Notifications\Settings` 下生成条目，因而被静默丢弃）；
3. `Shell_NotifyIcon` 气泡在这台机器上同样不显示。

所以插件改用自己绘制的卡片：`scripts/notify.ps1` 用 WPF 画右下角卡片、播 WAV，由 `scripts/notify-launch.vbs` 通过 `wscript.exe` 以**隐藏窗口**启动——不会闪黑框。位置按**物理像素**计算（本机 3840×2160 @150%，WPF 使用设备无关单位，只按 DIP 定位会落到截屏取不到的区域）。

如果你在别的部署里希望用原生 toast，可以改 `scripts/notify.ps1` 的渲染分支，插件的其余部分（事件接入、设置页、去重）都不用动。

---

## 设置项

设置写在 `<DSH_HOME>/windows-notify/settings.json`（默认 `C:\Users\<你>\.dsh\windows-notify\settings.json`），

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `events.<kind>.enabled` | `true` | 该场景是否通知 |
| `events.<kind>.sound` | 见上表 | 提示音引用（`bundled:*` / `system:*` / 绝对 wav 路径 / `none`） |
| `popupSeconds` | `0` | 提示持续时间：`0` = 不消失（默认），`3`–`30` = 自动消失秒数 |
| `childAgents` | `false` | 子代理（子任务 / 团队）是否也通知 |
| `eventLog` | `false` | 把每次通知追加写入 `windows-notify/events.log` |

也可以在 profile 的 `cordis.patch.yml` 里给这一行配默认值（设置页写入的值优先生效）：

```yaml
- id: windows-notify
  name: dsh-windows-notify
  config:
    enabled: true
    popupSeconds: 10
    events:
      completion:
        sound: system:chimes.wav
```

---

## 结构

```
dsh-windows-notify/
├─ lib/index.js      宿主半：事件接入、对话名解析、去重、focus 中继（SSE）、设置路由
├─ lib/settings.js   设置契约：默认值、归一化、分层合并、音效目录、focus 文件路径
├─ lib/catalog.js    六种通知的文案、强调色、徽标
├─ lib/notifier.js   进程隔离的弹窗投递（静默启动器 + 并发上限 + 会话槽位 + 跳转目标）
├─ lib/client.js     浏览器半：设置页（含提示持续时间滑块）+ 点击跳转的接收端
├─ scripts/notify.ps1        弹窗宿主（WPF 卡片 + 音效 + 常驻/定时 + 槽位堆叠 + 工具窗口样式 + 两个点击目标）
├─ scripts/notify-launch.vbs 无窗口启动器
├─ assets/*.wav              自带音效（6 个，来自 Windows Media，均为 0.9–2.5 秒）
└─ test/
   ├─ host.test.mjs        宿主半离线测试（53 项）
   ├─ client.test.mjs      浏览器半离线测试（12 项）
   ├─ integration.mjs      真实弹卡片：堆叠 / 替换 / 自动消失
   ├─ click-probe.mjs      真实合成点击：卡片正文点了没反应 / 提示行跳转 / ✕ 关闭 / 工具窗口样式
   ├─ stack-probe.mjs      真实弹卡片：上下堆叠 / 下层消失后上层塌陷补位（含被强杀的情况）
   ├─ events-probe.mjs     真实 HTTP + SSE：跳转请求经事件流到达页面
   ├─ raise-cards.mjs      造 N 张卡片并保持一段时间，供其他探针检查
   ├─ list-windows.ps1     列出卡片窗口（物理坐标 + 扩展样式）
   ├─ close-windows.ps1    关掉所有卡片（`-Wait` 轮询到清空）
   ├─ close-window.ps1     按窗口句柄关掉一张卡片（模拟被强杀）
   ├─ click-window.ps1     在指定物理坐标合成一次点击
   ├─ capture-window.ps1   按窗口自身像素截图（预览图就是它生成的）
   ├─ switcher-probe.ps1   报告卡片是否会被 Alt+Tab 列出
   ├─ style-control.ps1    对照实验：摘掉工具窗口样式后应立刻出现在 Alt+Tab 列表里（`-Hold` 则保持摘掉状态）
   ├─ foreground.ps1       打印当前前台窗口（排错用）
   ├─ list-top-windows.ps1 列出顶层窗口（排错用）
   ├─ probe-click-point.ps1 诊断点击落点与 DPI 坐标（排错用）
   └─ syntax-check.ps1     解析所有 .ps1 检查语法
```

`scripts/card-windows.ps1` 不属于测试：它是插件启动时用来「收养」屏幕上已有卡片（`-Action Adopt`）的维护脚本，测试也用它做 `-Action Close`。

## 开发注意（踩过的坑）

- **`scripts/` 里的 `.ps1` / `.vbs` 必须保持纯 ASCII。** Windows PowerShell 5.1 会把**无 BOM 的 UTF-8** 脚本按系统 ANSI 代码页解码，脚本里的中文常量会变成乱码字符，字体没有对应字形就渲染成**空白**（表现为「这一行占了高度却不显示」）。所有中文文案都放在宿主经 UTF-8 JSON 传给弹窗的载荷里；`test/host.test.mjs` 里有一条测试专门守这个约束。
- **卡片尺寸用 DIP，截图要用 DPI 感知的工具。** 窗口按物理像素渲染，而 `GetWindowRect` 对 DPI 不感知的进程返回虚拟化坐标；用它分配位图会**只截到左上角**（下面几行被悄悄裁掉）。这就是 `test/capture-window.ps1` 里 `SetProcessDPIAware()` 的原因，同理适用于合成点击的坐标。

## 测试

```powershell
# 宿主半 + 浏览器半，离线、不弹窗
node test/host.test.mjs
node test/client.test.mjs

# 会真的在屏幕上弹卡片并检查堆叠/替换/自动消失，跑完自己关掉
node test/integration.mjs

# 会对卡片做一次真实的合成鼠标点击（期间会短暂移动鼠标，随后还原），验证跳转请求
node test/click-probe.mjs

# 会弹两张卡片并验证堆叠与下层消失后的塌陷（会短暂占用右下角）
node test/stack-probe.mjs

# 用真实 HTTP + SSE 验证「跳转请求 -> 页面」这一段
node test/events-probe.mjs

# 只检查 PowerShell 语法
powershell -File test/syntax-check.ps1
```

## 排错

- **安装时报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `Lockfile failed supply-chain policy check`**：
  这不是本插件的问题。pnpm 会对**整个 lockfile** 做「新版本冷静期」（`minimumReleaseAge`）校验，profile 里已有的
  `@michengai/dsh-agency-agents@1.0.11` 是发布 24 小时内的新版本，于是 `pnpm add` 被整体拦下。两种解法：
  1. 直接从**本地目录**安装（推荐）：把 `E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify` 作为路径安装，pnpm 不会去 registry 解析新版本，也就不会触发这次校验；
  2. 若仍被拦：在 profile 的 `pnpm-workspace.yaml` 里补一条排除项后重试：

     ```yaml
     minimumReleaseAgeExclude:
       - '@michengai/dsh-agency-agents@1.0.11'
     ```

     或者先跑一次 `pnpm install`（pnpm 会自动补上这条排除项），再执行安装。
- **没有卡片**：确认插件已启用、`设置 → Windows 通知` 里「弹窗宿主」显示「就绪」；点「测试通知外观」。卡片的诊断写在 `~/.dsh/windows-notify/popup.log`（每次弹窗一行：落位、可用尺寸、目标点坐标、是否拿到工具窗口样式）。
- **点卡片没跳转**：① 点的是不是那行「点击跳转到该对话」——卡片的标题与正文点了不跳转（这是刻意的）；② 卡片上有没有那一行（没有说明这条通知不带对话，如登录提醒）；③ 在设置页看「监听页面数」是不是 1（为 0 说明浏览器半没连上事件流，刷新页面即可）；④ 宿主半是不是新版本（重启 DSH）。
- **卡片出现在 Alt+Tab 里**：新卡片是工具窗口，不会进 Alt+Tab。**旧版本弹出的卡片**没有这个样式（默认又不消失，所以它们会一直挂着），两种处理：

  1. 重启 DSH：插件启动时会自动「收养」屏幕上的已有卡片（补样式 + 摘掉切换器条目，不关闭它们）。
  2. 不想重启：手动收养或清掉它们：

     ```powershell
     # 收养（保留卡片，只是移出 Alt+Tab）
     powershell -NoProfile -ExecutionPolicy Bypass -File `
       E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify\scripts\card-windows.ps1 -Action Adopt
     # 或者直接关掉全部卡片
     powershell -NoProfile -ExecutionPolicy Bypass -File `
       E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify\scripts\card-windows.ps1 -Action Close
     ```

  想确认某张卡片当前是否会被 Alt+Tab 列出，用 `test/switcher-probe.ps1`（它会同时报告扩展样式与 owner）。`test/style-control.ps1` 是对照实验：摘掉样式后该卡片会立刻出现在列表里——说明这个检查不是「永远报否」的假通过。
- **合成点击的探针为什么有时报 INCONCLUSIVE**：`click-window.ps1` 会先把光标移过去、**确认落点窗口确实是这张卡片**，再按下；如果这期间你动了鼠标，它会重试 5 次，仍不成功就报 `verified=False`，`click-probe.mjs` 因此报 `INCONCLUSIVE` 并以退出码 2 结束——**这不是卡片的问题，只是那次点击无法证明落在卡片上**。跑探针时别动鼠标；探针结束会把光标放回原位。
- **点了卡片的标题/正文没反应**：这是刻意的——只有「点击跳转到该对话」那一行会跳转，✕ 只关闭；其余区域保持惰性，这样卡片上的文字可以正常选中与阅读。
- **跳转了但窗口没到前台**：Windows 有时会拒绝前台切换（前台锁）；点击弹窗本身通常能拿到权限，若仍不行，卡片至少会关掉、对话在下次切回 DSH 时已经打开。
- **卡片太多**：把「提示持续时间」滑块往左调成几秒，卡片就会自动消失；或者用上面的 `-Action Close` 一次清空。
- **卡片堆叠留下空隙**：卡片每 900ms 会按「我下面还有几张活着的卡片」重算位置，下层消失（✕ / 自动消失 / 进程被杀）后上层会在 1 秒内落下来补位。如果它一直悬空，说明弹窗宿主是旧版脚本。
- **有卡片没声音**：该项提示音是否被设成了静音；`C:\Windows\Media` 是否被精简（自带音效不依赖它）。
- **想看日志**：设置页打开「记录事件日志」，或看宿主日志里的 `windows-notify:` 行。
- **通知太频繁**：关掉「子代理也通知」，或把不关心的场景关掉。
- **装了但设置页没出现**：刷新一下 GUI 页面（客户端半的 bundle 在页面加载时装配）。
- **改了插件代码没生效 / 设置里版本号还是旧的**：profile 的 `node_modules/dsh-windows-notify` 必须是**指向本目录的链接**（junction）。
  如果它是一份**真实目录副本**，DSH 加载的就是那份旧副本，改源码不会有任何效果。**注意：在插件管理器里点「安装 / 重试」会调用 pnpm，它可能把链接重新变成一份副本**——症状就是「重启后设置里的版本号仍然没变、弹窗行为也还是旧的」。检查：

  ```powershell
  cmd /c dir /AL "$env:USERPROFILE\.dsh\profiles\desktop\node_modules" | findstr notify
  # 期望：<JUNCTION> dsh-windows-notify [\??\E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify]
  ```

  不是链接就重建（确认源码完整后再删）：

  ```powershell
  $dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-windows-notify"
  Remove-Item $dst -Recurse -Force
  New-Item -ItemType Junction -Path $dst -Target 'E:\Data\Project\DeepSeekHarness\DSH-Homemade-Plugins\dsh-windows-notify'
  ```

  之后重启 DSH：宿主半是 `import` 进进程的，改完必须重启；卡片外观（`scripts/notify.ps1`）下次弹窗即生效，设置页刷新页面即可。
