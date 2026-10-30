# astrbot_plugin_pc_control — 让 AstrBot 真的操作电脑、刷抖音

AstrBot 4.x 插件。移植自 DSH 插件 [dsh-plugin-computer-use](https://github.com/xiaodelx/douyin)，
两边共用同一个 Win32 后端 `agent.ps1`（常驻 PowerShell，`SendInput` + GDI），只是工具层换成了
AstrBot 的 `@llm_tool`。

> DSH 插件是 JS/Cordis 生态，AstrBot 是 Python/Star 生态，两者不能直接互相加载——所以这里是**移植**，
> 不是"安装同一个包"。行为、参数、安全闸都对齐。

## 能力

| 工具 | 动作 |
| --- | --- |
| `pc_screenshot` | `mode=screen/window`，可把截图直接发到会话 |
| `pc_mouse` | `move` / `click` / `scroll` / `drag` |
| `pc_keyboard` | `type`（中文直接注入）/ `key` / `hotkey`（`ctrl+shift+esc`） |
| `pc_window` | `list` / `focus` / `launch` / `clipboard_get` / `clipboard_set` / `wait` / `panic` / `resume` / `screen_info` |
| `douyin` | `status` / `open` / `enter` / `next` / `prev` / `like` / `pause` / `play` / `watch` / `stop` |

抖音的两种目标自动适配：

- **PC 客户端**（窗口标题以"抖音"开头）：首页是网格，先 `enter` 点开视频，`next` 发方向键；
  点赞点右侧红心（距右边缘约 123px）。
- **网页版**（浏览器标签）：`next` 用滚轮，点赞双击画面。

急停：**Ctrl+Alt+Shift+Q**（全局），或 `pc_window(action=panic)` / `douyin(action=stop)`；
`pc_window(action=resume)` 解除。

## 安装

**从 GitHub 装（推荐）**：AstrBot WebUI →「插件」→「安装插件」→ 填仓库地址

```
https://github.com/xiaodelx/douyin
```

AstrBot 会在仓库**根目录**找 `metadata.yaml` 和 `main.py`，这个仓库根目录就是插件本体，所以能直接装。
装好后在「插件」页点**重载**（或重启 AstrBot），日志里应出现
`Added llm tool: pc_screenshot ... douyin`。

> 同一个仓库里还平行放了 DeepSeek Harness 版（`package.json` + `lib/` + `dsh` 相关文件），
> AstrBot 装的时候会一起拷走但完全忽略，两者互不影响。DSH 版说明见 [README.md](README.md)。

**手动安装**：把仓库根目录整个复制成 `<ASTRBOT_DATA>/plugins/astrbot_plugin_pc_control`：

| 文件 | 作用 |
| --- | --- |
| `main.py` | 插件与 5 个工具 |
| `agent.ps1` | Win32 桌面后端（常驻 PowerShell） |
| `metadata.yaml` | 插件元信息（安装器必读） |
| `_conf_schema.json` | 配置项定义 |
| `requirements.txt` | 空，无第三方依赖 |

Windows 桌面版的 `<ASTRBOT_DATA>` 默认是 `C:\Users\<你>\.astrbot\data`，即
`C:\Users\<你>\.astrbot\data\plugins\astrbot_plugin_pc_control`。

依赖：**无**。只用标准库 + Windows 自带的 `powershell.exe`。

## 权限

默认**只允许管理员**调用（`allow_non_admin: false`）。在 QQ 群里用之前，把发令人的 QQ 号加进
AstrBot 的 `admins_id`（WebUI → 配置 → 管理员），否则机器人会回复"电脑控制默认只允许管理员使用"。

把 `allow_non_admin` 设为 `true` 等于把鼠标键盘交给群里所有人，**强烈不建议**。

## 配置（插件配置页）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `allow_non_admin` | `false` | 是否允许非管理员使用 |
| `screenshot_max_width` | `1280` | 截图最长边，越小越省流量 |
| `agent_timeout_ms` | `20000` | 单条桌面指令超时 |
| `output_dir` | 空 | 截图目录，默认 `~/.astrbot/plugin_data/pc_control` |
| `douyin_url` | `https://www.douyin.com/` | `douyin open` 打开的地址 |
| `douyin_window_title` | `抖音` | 认窗口用的标题关键字 |
| `max_watch_count` | `10` | 批量观看默认条数（硬上限 50） |
| `min_dwell_ms` / `max_dwell_ms` | `3000` / `10000` | 每条停留时间区间 |
| `like_chance` | `0.2` | 批量观看时点赞概率 |
| `max_likes_per_run` | `3` | 单次批量最多点赞数 |
| `open_timeout_ms` | `25000` | 等抖音窗口出现的时间 |

## 怎么用

在 WebChat / QQ 里直接对机器人说：

> 把抖音客户端切到前台，刷 5 条视频，每条停 5 秒

> 截个屏发我看看现在桌面是什么样

> 帮我在坐标 800,600 点一下

机器人会自己挑 `pc_screenshot` / `douyin` / `pc_mouse` 这些工具。

## 一个必须知道的限制

**模型能不能"看见"截图，取决于你用的模型。** 你现在配的是 DeepSeek（`api.deepseek.com`，纯文本），
所以截图只能作为图片发到会话里给**你**看，模型本身看不到画面内容。这意味着：

- 需要"看图找按钮"的操作，得由你给出坐标，或者依赖固定布局（抖音那几个快捷键就是这样）；
- 换成支持视觉的模型（GPT-4o / Qwen-VL / GLM-4V 等）后，截图才真正进入模型的上下文。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 日志没有 `Added llm tool` | 看 AstrBot 启动日志里的插件报错；确认目录名和 `metadata.yaml` 的 `name` 一致 |
| 提示"只允许管理员" | 把发令人加进 `admins_id`，或（不建议）开 `allow_non_admin` |
| 抖音窗口"存在但不可用" | 客户端被收进"抖音挂件"/托盘，点托盘图标恢复主窗口 |
| 网页版画面不动 | 登录弹窗挡住了，先扫码登录；插件不会代登录 |
| 截图是黑的 | 视频走硬件覆盖层，换 `mode=window` |
| `spawn` 类错误 | Windows 需要 `powershell.exe` 在 PATH 里（系统自带） |

## 卸载

在插件页停用并删除该目录即可；同时可以删掉 `data/config/astrbot_plugin_pc_control_config.json` 和
`~/.astrbot/plugin_data/pc_control`。

## 许可

MIT。与 DeepSeek、字节跳动无关；"抖音"是其权利人的商标，这里只用来描述被驱动的窗口。
