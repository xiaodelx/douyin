# dsh-plugin-computer-use — 让大肥鱼真的能操作电脑、刷抖音

一个 DeepSeek Harness（DSH）组合包：给 agent 装上**真实的鼠标、键盘和屏幕**，并在此之上提供一个"刷抖音"的驱动器。

仓库：<https://github.com/xiaodelx/douyin>

## 两套实现，同一个后端

| 目录 | 目标平台 | 安装方式 |
| --- | --- | --- |
| 仓库根目录 | DeepSeek Harness（Cordis / ESM） | `dsh plugin --profile desktop add .` |
| [`astrbot/astrbot_plugin_pc_control`](astrbot/astrbot_plugin_pc_control) | AstrBot 4.x（Star / Python） | 复制到 `<ASTRBOT_DATA>/plugins/` 后重载插件 |

两边共用同一个 `agent.ps1`（常驻 PowerShell + `SendInput`/GDI），工具契约各自适配插件体系；能力、坐标规则、急停键（`Ctrl+Alt+Shift+Q`）一致。**下文是 DSH 版的完整说明，AstrBot 版见子目录里的 README。**

- 工具 `computer`：截图、移动/点击/拖拽、滚轮、打字、快捷键、窗口枚举与聚焦、启动程序、剪贴板、等待、急停。
- 工具 `douyin`：打开抖音网页版、上/下滑视频、点赞、暂停/播放、批量"看视频"、校准按钮坐标、评论（需显式确认）。
- 所有输入都是**真的发生在你的桌面上**（Win32 `SendInput` + GDI 截图），不是模拟器、不是接口调用。
- 随时可以**急停**：按住 `Ctrl+Alt+Shift+Q`，之后一切模拟输入都会被拒绝，直到调用 `computer` 的 `resume`。

> 抖音没有公开的"刷视频"接口，本插件也不去碰私有接口或账号 Cookie：它只是像人一样在浏览器窗口里滚轮、点击、等待。
> 请自行确认这符合抖音的用户协议与当地法律；点赞/评论是公开行为，默认只允许少量、可配置。

---

## 1. 安装

```powershell
git clone https://github.com/xiaodelx/douyin.git
cd douyin

# 以本地链接方式装进 desktop profile；dsh 会自动把本包追加进 bundles 列表
dsh plugin --profile desktop add .

# 不启动、只检查组合结果里是否出现本插件的层
dsh --profile desktop --dump-config
```

`dsh` 就是 DeepSeek Harness 自带的启动器：Desktop 安装版在
`<安装目录>\resources\runtime\cli\bin\dsh.cmd`，源码版是 `pnpm dsh`。

安装后工具会**热加载**（实测：装完当前会话立刻多出 `computer` 和 `douyin`）；如果没出现，重启一次 DeepSeek Harness。

其它安装方式：

| 方式 | 命令 |
| --- | --- |
| 本地目录（开发用，改代码后重载即可） | `dsh plugin --profile desktop add .` |
| 打包成 tarball 分发 | `pnpm pack` 后 `dsh plugin --profile desktop add .\dsh-plugin-computer-use-0.1.0.tgz` |
| 发布到 npm 后 | `dsh plugin --profile desktop add dsh-plugin-computer-use` |
| 临时试用（不改 profile） | `dsh web --patch .\cordis.patch.yml`（此时 `name` 要写成绝对路径，见下） |

> 用 `--patch` 直接加载源码时，patch 行里的 `name` 必须是绝对路径，例如
> `name: 'D:/work/dsh-plugin-computer-use/lib/index.js'`。作为 bundle 安装时写的
> `name: dsh-plugin-computer-use` 才能被 Node 的模块解析找到。

卸载：

```powershell
dsh plugin --profile desktop remove dsh-plugin-computer-use
```

---

## 2. 配置

配置写在 profile 的 `cordis.patch.yml`（覆盖本包自带的默认值），或改本包的 `cordis.patch.yml`。
所有字段都带 schema 校验，写错会在加载时报错而不是静默生效。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `screenshotMaxWidth` | `1280` | 截图最长边像素。越小越省 token，越大细节越多。 |
| `agentTimeoutMs` | `20000` | 单条指令的超时。 |
| `outputDir` | 空（系统临时目录） | 截图与代理状态目录，默认 `%TEMP%\dsh-pc-control`。 |
| `douyinUrl` | `https://www.douyin.com/` | `douyin open` 打开的地址。 |
| `douyinWindowTitle` | `抖音` | 用窗口标题里的关键字认窗口。 |
| `maxWatchCount` | `20` | 单次 `watch` 的默认视频数上限（硬上限 50）。 |
| `minDwellMs` / `maxDwellMs` | `3000` / `12000` | 每个视频停留时间的随机区间。 |
| `likeChance` | `0.2` | 批量观看时给一个视频点赞的概率，0 表示不点赞。 |
| `maxLikesPerRun` | `5` | 单次批量最多点赞数。 |
| `openTimeoutMs` | `25000` | `open` 等待窗口出现的时间。 |

---

## 3. 用起来

最省事的说法（大肥鱼会自己挑工具）：

> 帮我看 8 个抖音视频，每个停留 5 秒左右，顺手点几个赞。

它会：`douyin status` → `douyin open`（没开就开）→ `douyin watch { count: 8, min_dwell_ms: 4000, max_dwell_ms: 7000 }`。

### 3.1 `computer` 动作表

| action | 关键参数 | 说明 |
| --- | --- | --- |
| `screen_info` | – | 分辨率、缩放（DPI 感知）、光标、前台窗口。 |
| `screenshot` | `mode`: `screen`/`window`/`region`、`window`、`x,y,width,height`、`max_width` | 存成 PNG 并返回路径，配合 `read_image` 看画面。 |
| `cursor` | – | 光标坐标 + 前台窗口。 |
| `move` | `x, y, duration_ms` | 带缓动的移动。 |
| `click` | `x?, y?, button, count, interval_ms` | 不给坐标就点当前位置；`count: 2` 是双击。 |
| `drag` | `x1,y1,x2,y2,duration_ms,button` | 按住拖动，适合"上滑换视频"。 |
| `scroll` | `x?,y?,delta,times,interval_ms` | `delta` 负数向下滚。 |
| `type` | `text` | 直接注入 Unicode 字符，中文不依赖输入法。 |
| `key` | `key, times` | 单键，如 `enter`、`tab`、`space`、`down`、`f5`。 |
| `hotkey` | `keys` | 组合键，如 `["ctrl","shift","esc"]`。 |
| `windows` | `filter?` | 枚举可见窗口（句柄、标题、位置、尺寸、是否前台）。 |
| `focus` | `window` | 句柄或标题子串；抢焦点失败会明确告诉你。 |
| `launch` | `target, args?` | 启动 URL 或可执行文件。 |
| `clipboard_get` / `clipboard_set` | `text` | 读写剪贴板。 |
| `wait` | `ms` | 等待期间会轮询急停键，最长 60s。 |
| `panic` / `resume` | – | 拉起/清除急停标志。 |

### 3.2 `douyin` 动作表

| action | 关键参数 | 说明 |
| --- | --- | --- |
| `status` | `screenshot?` | 窗口是否在、是否前台、光标在窗口内的相对位置；`screenshot: true` 附一张窗口截图。 |
| `open` | `url?` | 没有窗口就打开网页版并等它出现。 |
| `enter` | `layout.open?` | **PC 客户端**：点开第一张视频卡片，进入播放页。 |
| `next` / `prev` | `times`, `method` | 换视频：PC 客户端默认方向键（↓/↑），网页版默认滚轮。 |
| `like` | `layout.like?` | PC 客户端点右侧红心；网页版双击画面。 |
| `pause` / `play` | – | 空格。 |
| `watch` | `count`, `min_dwell_ms`, `max_dwell_ms`, `like_chance`, `max_likes`, `screenshot_every`, `enter` | 批量观看，返回看了几个、赞了几个、截图路径、是否被急停。`enter: true` 会先点开第一张卡片。 |
| `comment` | `text`, `confirm: true`, `layout.comment` | 只有显式确认才会发评论。 |
| `calibrate` | – | 返回光标相对窗口的坐标 + 窗口截图，用来标定按钮。 |
| `stop` | – | 拉起急停标志。 |

### 3.3 抖音 PC 客户端 vs 网页版

实测（2026-10 版抖音 PC 客户端 + Chrome 网页版）：

| 场景 | 行为 | 插件的处理 |
| --- | --- | --- |
| PC 客户端首页 | 三列**网格**，滚轮翻页；方向键**不生效** | 先 `enter` 点开一个视频，再 `watch`；`next` 在网格上不会假装成功（返回文本里会提示） |
| PC 客户端播放页 | ↓/↑ 切换视频，会短暂显示"加载中" | `next` 默认发方向键，并等 1.5-1.9s 让下一条缓冲 |
| PC 客户端右侧操作栏 | 头像、红心、评论、收藏、分享，距右边缘约 123px | `like` 默认点红心（`right-123px, 0.47h`），`comment` 默认点评论图标（`0.54h`） |
| 网页版 | 滚轮切换；双击画面点赞；未登录会弹**登录框**挡住画面 | `next` 默认滚轮；`like` 默认双击；`status`/`watch` 带截图，方便一眼看出被登录框挡住 |
| 客户端"关闭"到挂件/托盘 | 主窗口变成 929×153 的"抖音挂件"，主窗口句柄变成 199×34 且在 -32000 处 | `status` 明确报告"窗口存在但不可用"；驱动类动作会尝试 `SW_RESTORE` 一次，失败就提示你把主窗口点回来，**不会盲点** |

> 登录墙/验证码是插件的红线：它不会扫码、不会绕过，只会把截图交给你并停下。

### 3.4 校准点赞/评论按钮

不同分辨率、窗口尺寸下按钮位置会变，所以既可以直接用内置坐标，也可以自己标定：把鼠标悬停在按钮上，然后说：

> 校准一下抖音的点赞按钮

大肥鱼调用 `douyin calibrate`，拿到 `cursor.relative = { x, y }`，之后这样调用即可：
`douyin like { layout: { like: { x: 0.93, y: 0.62 } } }`。

---

## 4. 安全边界

插件刻意只做"人手能做的输入"，并保留几道闸：

- **急停**：`Ctrl+Alt+Shift+Q`（全局、任何时刻），或调用 `computer { action: "panic" }` / `douyin { action: "stop" }`。
  急停后所有输入指令返回 `KILL_SWITCH`，批量观看立刻中断并返回已完成的部分。
- **不碰凭据**：不读 Cookie、不注入 JS、不调私有 API、不保存登录态。
- **不自动社交**：评论必须 `confirm: true` 且文字由用户给出（≤120 字）；不自动关注、私信、转发。
- **点赞有上限**：`likeChance` 与 `maxLikesPerRun` 双重限制。
- **窗口守卫**：动作前确认目标窗口在前台；抢不到焦点就报错，绝不在别的窗口上盲点。
- **不做破坏性操作**：删除、格式化、支付、卸载这类对话框需要用户自己点。

---

## 5. 原理与结构

```
dsh-plugin-computer-use/
├── package.json          # dsh.bundle → cordis.patch.yml
├── cordis.patch.yml      # 往 profile 里插入一行 computer-use
├── lib/
│   ├── index.js          # 插件的 apply()：配置、两个工具、安全闸
│   ├── agent-client.js   # 常驻 PowerShell 代理的 JSON-line 客户端（含超时/重启/中止）
│   ├── agent.ps1         # 真正干活的 Win32 代理（SendInput / GDI 截图 / 窗口枚举）
│   └── douyin.js         # 抖音动作编排（只看窗口，不碰接口）
└── test/smoke.mjs        # 不启动 DSH 也能跑的工具级冒烟测试
```

- 每个插件实例启动**一个常驻 `powershell.exe`**（`-STA`，因此剪贴板可用）。握手后每条指令只是一行 JSON，往返几毫秒，比每次冷启动 PowerShell 快一个数量级。
- 代理启动时调用 `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`，所以 `GetSystemMetrics`、`SetCursorPos` 和截图**都用同一套物理像素**——这是坐标能对上的关键；不开 DPI 感知时 125% 缩放下 1920×1080 会被报成 1536×864。
- 截图优先 `PrintWindow(PW_RENDERFULLCONTENT)`，失败回退 `CopyFromScreen`；多显示器用虚拟屏坐标。
- 文本输入走 `KEYEVENTF_UNICODE`，中文/emoji 不经过输入法，直接落到焦点控件。
- 代理进程崩溃或超时会被下一次调用自动重启；插件卸载时通过 `ctx.effect` 关掉它。

---

## 6. 故障排查

| 现象 | 处理 |
| --- | --- |
| 工具没出现 | `dsh --profile desktop --dump-config` 看有没有 `# == dsh-plugin-computer-use` 层；确认已重启应用。 |
| `douyin status` 说"窗口存在但不可用" | 客户端被收进了"抖音挂件"/托盘：点一下挂件或托盘图标把主窗口恢复，再重试。 |
| 网页版画面不动 | 多半是登录弹窗盖住了：先扫码登录。插件不会代你登录。 |
| 点了没反应 / 抢不到焦点 | Windows 的前台锁：先手动点一下目标窗口；`focus` 会明确返回 `activated: false`。 |
| 截图是黑的 | 视频走硬件覆盖层时 `CopyFromScreen` 会黑；改用 `mode: "window"`（PrintWindow）。 |
| 中文变问号 | 代理必须用 `powershell.exe`（5.1）并且走 UTF-8 管道；不要用 `pwsh` 替换 `agent-client.js` 里的可执行文件名。 |
| `spawn EPERM` | 你在 DSH 沙箱里直接跑了 `node test/smoke.mjs`；沙箱禁止带管道的子进程，把测试放到普通终端或放宽权限。 |
| 急停后动不了 | `computer { action: "resume" }`。 |

---

## 7. 本地测试

`test/smoke.mjs` 用假 `ctx` 注册工具，然后真实执行：`screen_info`、`screenshot`、`cursor`、`move`（原地）、`windows`、`clipboard_set/get`（含中文 emoji）、`wait`、`douyin status`（如窗口在），并校验 `defineTool` 的 schema 能编译。
它**不会**点击、打字或打开抖音。

因为插件按 DSH 的约定从运行时解析 `@deepseek-ai/*`，直接在普通终端跑会因为找不到这些包而失败。开发机上把 DSH 安装里的 `node_modules`（解包后的 `app.asar/dsh/node_modules`）临时链接过来即可：

```powershell
# 仅在开发/测试时需要；装进 profile 的插件走运行时解析，不需要这一步
New-Item -ItemType Junction -Path '.\node_modules' -Target '<解包后的 dsh/node_modules 路径>'
node test\smoke.mjs
Remove-Item '.\node_modules'
```

---

## 8. 已知限制

- **不识别画面内容**：插件只负责截图，理解画面的是模型；所以"这条视频好不好看"要靠模型看图判断。
- **坐标依赖版本**：PC 客户端/网页改版后右侧按钮位置可能变，`calibrate` + `layout` 是兜底手段。
- **会占用真实鼠标键盘**：`watch` 运行期间你最好别同时操作；随时 `Ctrl+Alt+Shift+Q` 急停。
- **不绕过登录/验证码/风控**：遇到就停下并把截图交给你。
- **单次 `watch` 有预算**：最多 50 条、8 分钟，且是前台阻塞调用（不会偷偷在后台跑）。
- **只支持 Windows**：依赖 `powershell.exe` + `user32.dll`。

---

## 9. 许可

MIT。与 DeepSeek、字节跳动无关；"抖音"是其权利人的商标，这里只用于描述被驱动的窗口。
