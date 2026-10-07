# dsh-windows-notify

给 DSH 加上 **Windows 桌面通知 + 分场景提示音**：对话完成、出错、等待你审批、等待你确认（计划评审）、等待你回答、需要登录账号，各自弹出通知卡片并播放**互不相同**的提示音。

> 通知卡片是插件自绘的（右下角、深色卡片、彩色强调条 + 圆角徽标），**不抢焦点**：不会把你正在打字的窗口切走；点一下或等几秒自动消失。

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

默认的**提示持续时间是不消失**：卡片一直留在右下角，点一下才关闭。因为这样卡片会越积越多，插件按**会话**给卡片分槽位：

- 不同会话各占一层，**向上堆叠**，不会互相遮挡；
- 同一会话的新通知**替换**自己上一层（不会堆出一列旧通知）；
- 会话的弹窗进程异常退出后，槽位会被自动回收；
- 把滑块往左调成 N 秒，卡片就会在 N 秒后自动消失。

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
├─ lib/index.js      宿主半：事件接入、对话名解析、去重、设置路由（/windows-notify/api）
├─ lib/settings.js   设置契约：默认值、归一化、分层合并、音效目录
├─ lib/catalog.js    六种通知的文案、强调色、徽标
├─ lib/notifier.js   进程隔离的弹窗投递（静默启动器 + 并发上限 + 会话槽位 + 陈旧载荷清理）
├─ lib/client.js     浏览器半：设置页（含提示持续时间滑块）
├─ scripts/notify.ps1        弹窗宿主（WPF 卡片 + 音效 + 常驻/定时 + 槽位堆叠）
├─ scripts/notify-launch.vbs 无窗口启动器
├─ assets/*.wav              自带音效（6 个，来自 Windows Media，均为 0.9–2.5 秒）
└─ test/                     离线测试（宿主 43 项 / 浏览器 8 项）+ 实时集成测试
```

## 测试

```powershell
# 宿主半 + 浏览器半，离线、不弹窗
node test/host.test.mjs
node test/client.test.mjs

# 会真的在屏幕上弹卡片并检查堆叠/替换/自动消失，跑完自己关掉（手动跑）
node test/integration.mjs
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
- **没有卡片**：确认插件已启用、`设置 → Windows 通知` 里「弹窗宿主」显示「就绪」；点「测试通知外观」。
- **卡片太多**：把「提示持续时间」滑块往左调成几秒，卡片就会自动消失。
- **有卡片没声音**：该项提示音是否被设成了静音；`C:\Windows\Media` 是否被精简（自带音效不依赖它）。
- **想看日志**：设置页打开「记录事件日志」，或看宿主日志里的 `windows-notify:` 行。
- **通知太频繁**：关掉「子代理也通知」，或把不关心的场景关掉。
- **装了但设置页没出现**：刷新一下 GUI 页面（客户端半的 bundle 在页面加载时装配）。
- **改了插件代码没生效 / 设置里版本号还是旧的**：profile 的 `node_modules/dsh-windows-notify` 必须是**指向本目录的链接**（junction）。
  如果它是一份**真实目录副本**，DSH 加载的就是那份旧副本，改源码不会有任何效果（本插件第一版安装后就是这种情况）。检查：

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
