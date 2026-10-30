"""AstrBot 插件：让机器人真的操作 Windows 桌面，并且能刷抖音。

移植自 DSH 插件 dsh-plugin-computer-use（https://github.com/xiaodelx/douyin）。
两边共用同一个 Win32 后端 `agent.ps1`：一个常驻 PowerShell 进程，通过 JSON 行协议
接收指令，用 SendInput / GDI 完成鼠标、键盘、截图和窗口操作。

与 DSH 版的差异：
- 工具改成 AstrBot 的 `@llm_tool`（扁平参数，动作用字符串区分）；
- 截图可以把图片直接发到当前会话，让用户看到模型正在看什么；
- 去掉了"发评论"能力：群聊里让机器人代发评论风险太高，需要时请自己在客户端操作。
"""

from __future__ import annotations

import asyncio
import json
import random
import subprocess
from pathlib import Path
from typing import Any

from astrbot.api import AstrBotConfig, llm_tool, logger
from astrbot.api.event import AstrMessageEvent, MessageChain
from astrbot.api.star import Context, Star

PLUGIN_DIR = Path(__file__).resolve().parent
AGENT_SCRIPT = PLUGIN_DIR / "agent.ps1"

# 浏览器标题里出现这些词，说明面对的是网页版而不是 PC 客户端。
BROWSER_TITLE = ("chrome", "edge", "firefox", "brave", "opera", "vivaldi", "safari", "360", "chromium", "浏览器")

# PC 客户端把右侧操作栏固定画在离右边缘约 123px 的位置（1730x997 实测），
# 用像素偏移比相对坐标更抗窗口缩放。
CLIENT_RAIL_RIGHT_PX = 123
CLIENT_LIKE_RATIO = 0.47
CLIENT_COMMENT_RATIO = 0.54
CLIENT_OPEN_RATIO = (0.26, 0.30)

CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

DEFAULTS: dict[str, Any] = {
    "agent_timeout_ms": 20000,
    "screenshot_max_width": 1280,
    "output_dir": "",
    "allow_non_admin": False,
    "douyin_url": "https://www.douyin.com/",
    "douyin_window_title": "抖音",
    "max_watch_count": 10,
    "min_dwell_ms": 3000,
    "max_dwell_ms": 10000,
    "like_chance": 0.2,
    "max_likes_per_run": 3,
    "open_timeout_ms": 25000,
}


class PcAgentError(Exception):
    """桌面代理返回的错误，`code` 区分普通错误与急停。"""

    def __init__(self, message: str, code: str = "ERROR") -> None:
        super().__init__(message)
        self.code = code


class DesktopAgent:
    """常驻 PowerShell 代理的异步客户端（JSON 行协议）。"""

    def __init__(self, root: Path, timeout_ms: int = 20000) -> None:
        self.root = root
        self.timeout = max(2.0, timeout_ms / 1000)
        self._proc: asyncio.subprocess.Process | None = None
        self._lock = asyncio.Lock()
        self._seq = 0

    async def _ensure_started(self) -> None:
        if self._proc is not None and self._proc.returncode is None:
            return
        self.root.mkdir(parents=True, exist_ok=True)
        self._proc = await asyncio.create_subprocess_exec(
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-STA",
            "-File",
            str(AGENT_SCRIPT),
            "-Root",
            str(self.root),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            creationflags=CREATE_NO_WINDOW,
        )
        try:
            ready = await asyncio.wait_for(self._proc.stdout.readline(), self.timeout)
        except asyncio.TimeoutError as exc:
            await self._kill()
            raise PcAgentError(f"桌面代理启动超时（{self.timeout:.0f}s）") from exc
        if not ready:
            err = b""
            if self._proc.stderr is not None:
                err = await self._proc.stderr.read()
            await self._kill()
            raise PcAgentError("桌面代理启动失败：" + err.decode("utf-8", "replace").strip()[:400])

    async def call(self, cmd: str, timeout: float | None = None, **args: Any) -> dict:
        async with self._lock:
            await self._ensure_started()
            assert self._proc is not None and self._proc.stdin is not None and self._proc.stdout is not None
            self._seq += 1
            request_id = self._seq
            payload = json.dumps({"id": request_id, "cmd": cmd, "args": args}, ensure_ascii=False)
            try:
                self._proc.stdin.write((payload + "\n").encode("utf-8"))
                await self._proc.stdin.drain()
                limit = timeout or self.timeout
                while True:
                    line = await asyncio.wait_for(self._proc.stdout.readline(), limit)
                    if not line:
                        raise PcAgentError("桌面代理已退出")
                    message = json.loads(line.decode("utf-8", "replace"))
                    if message.get("id") != request_id:
                        continue  # 就绪行或上一条的残留
                    if message.get("ok"):
                        return message.get("data") or {}
                    raise PcAgentError(message.get("error") or "桌面代理返回错误", message.get("code", "ERROR"))
            except (asyncio.TimeoutError, PcAgentError) as exc:
                # 超时或协议错误后，流可能已经错位：杀掉进程，下次调用重启。
                await self._kill()
                if isinstance(exc, PcAgentError):
                    raise
                raise PcAgentError(f"桌面指令 {cmd} 超时") from exc
            except Exception as exc:  # noqa: BLE001 - 管道破损等
                await self._kill()
                raise PcAgentError(f"桌面代理通信失败：{exc}") from exc

    async def _kill(self) -> None:
        proc, self._proc = self._proc, None
        if proc is None:
            return
        try:
            if proc.returncode is None:
                proc.kill()
                await asyncio.wait_for(proc.wait(), 3)
        except Exception:  # noqa: BLE001
            pass

    async def close(self) -> None:
        proc = self._proc
        if proc is not None and proc.stdin is not None and proc.returncode is None:
            try:
                proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass
        await self._kill()


class PcControlPlugin(Star):
    """Windows 桌面控制 + 抖音。

    工具：pc_screenshot / pc_mouse / pc_keyboard / pc_window / douyin。
    所有输入都会真的发生在宿主桌面上，急停键为 Ctrl+Alt+Shift+Q。
    """

    def __init__(self, context: Context, config: AstrBotConfig | None = None) -> None:
        super().__init__(context)
        self.cfg = {**DEFAULTS, **dict(config or {})}
        root = str(self.cfg.get("output_dir") or "").strip()
        self.root = Path(root) if root else Path.home() / ".astrbot" / "plugin_data" / "pc_control"
        self.agent = DesktopAgent(self.root, int(self.cfg["agent_timeout_ms"]))

    async def terminate(self) -> None:
        """插件卸载/重载时关掉常驻 PowerShell。"""
        await self.agent.close()

    # ------------------------------------------------------------------ 内部工具

    def _deny_reason(self, event: AstrMessageEvent) -> str | None:
        if self.cfg.get("allow_non_admin"):
            return None
        try:
            if event.is_admin():
                return None
        except Exception:  # noqa: BLE001 - 某些平台事件没有权限信息
            return None
        return "电脑控制默认只允许管理员使用。请让管理员在插件配置里打开 `allow_non_admin`，或在 AstrBot 管理员列表里加上你。"

    @staticmethod
    def _friendly_error(exc: Exception) -> str:
        if isinstance(exc, PcAgentError):
            if exc.code == "KILL_SWITCH":
                return "操作已被急停（Ctrl+Alt+Shift+Q 或 panic）。确认要继续后调用 pc_window(action=resume)。"
            return f"桌面操作失败：{exc}"
        return f"桌面操作失败：{exc}"

    @staticmethod
    def _is_browser(title: str) -> bool:
        low = title.lower()
        return any(word in low for word in BROWSER_TITLE)

    async def _windows(self) -> list[dict]:
        data = await self.agent.call("windows")
        return data.get("windows") or []

    async def _douyin_candidates(self) -> list[dict]:
        keyword = str(self.cfg["douyin_window_title"] or "抖音")
        rows = []
        for win in await self._windows():
            title = str(win.get("title") or "").strip()
            if not title or "deepseek harness" in title.lower():
                continue
            if keyword.lower() not in title.lower():
                continue
            if self._is_browser(title) or title.lower().startswith(keyword.lower()):
                rows.append(win)
        return rows

    @staticmethod
    def _usable(win: dict) -> bool:
        return win.get("width", 0) >= 480 and win.get("height", 0) >= 320 and win.get("x", 0) > -10000

    async def _douyin_window(self, restore: bool = True) -> dict | None:
        rows = await self._douyin_candidates()
        usable = sorted((w for w in rows if self._usable(w)), key=lambda w: w["width"] * w["height"], reverse=True)
        if usable:
            return usable[0]
        if not restore or not rows:
            return None
        # 客户端可能被收进"抖音挂件"/托盘：给它一次 SW_RESTORE 的机会。
        smallest = sorted(rows, key=lambda w: w["width"] * w["height"], reverse=True)[0]
        await self.agent.call("focus", window=str(smallest["hwnd"]))
        await self.agent.call("wait", ms=900)
        rows = [w for w in await self._douyin_candidates() if self._usable(w)]
        return sorted(rows, key=lambda w: w["width"] * w["height"], reverse=True)[0] if rows else None

    async def _focus_douyin(self) -> dict:
        win = await self._douyin_window()
        if win is None:
            raise PcAgentError("没有可用的抖音窗口：先用 douyin(action=open) 打开网页版，或把 PC 客户端主窗口从托盘恢复。")
        cursor = await self.agent.call("cursor")
        if (cursor.get("foreground") or {}).get("hwnd") == win["hwnd"]:
            info = await self.agent.call("window_info", window=str(win["hwnd"]))
            return {**win, **info}
        focused = await self.agent.call("focus", window=str(win["hwnd"]))
        await self.agent.call("wait", ms=240)
        if not focused.get("activated"):
            raise PcAgentError(f"无法把抖音窗口「{win.get('title')}」切到前台：请先手动点一下它。")
        info = await self.agent.call("window_info", window=str(win["hwnd"]))
        return {**win, **info}

    @staticmethod
    def _point(win: dict, rx: float, ry: float, jitter: float = 0.01) -> tuple[int, int]:
        rx = min(0.98, max(0.02, rx + random.uniform(-jitter, jitter)))
        ry = min(0.98, max(0.02, ry + random.uniform(-jitter, jitter)))
        return int(win["x"] + win["width"] * rx), int(win["y"] + win["height"] * ry)

    async def _swipe(self, direction: str, times: int, method: str, win: dict) -> str:
        kind = "web" if self._is_browser(str(win.get("title") or "")) else "client"
        method = method or ("wheel" if kind == "web" else "key")
        times = max(1, min(20, int(times)))
        if method == "key":
            key = "down" if direction == "next" else "up"
            for _ in range(times):
                await self.agent.call("key", key=key, times=1, interval_ms=40)
                await self.agent.call("wait", ms=1500 if kind == "client" else 350)
        else:
            x, y = self._point(win, 0.5, 0.55)
            delta = -120 if direction == "next" else 120
            await self.agent.call("scroll", x=x, y=y, delta=delta, times=times, interval_ms=90)
            await self.agent.call("wait", ms=320)
        word = "下一条" if direction == "next" else "上一条"
        return f"已切换到{word}（{times} 次，{'方向键' if method == 'key' else '滚轮'}）。"

    # ------------------------------------------------------------------ 工具：截图

    @llm_tool(name="pc_screenshot")
    async def pc_screenshot(
        self,
        event: AstrMessageEvent,
        mode: str = "screen",
        window: str = "",
        send_to_user: bool = True,
    ):
        """截取这台电脑的屏幕并保存成 PNG。当前对话模型若支持视觉就能直接看图；否则请把截图发给用户看。

        Args:
            mode(string): screen 截整个屏幕，window 截指定窗口，region 截屏幕的一块区域
            window(string): window 模式下的窗口句柄或标题片段，留空表示当前前台窗口
            send_to_user(boolean): 是否把截图作为图片发到当前会话，默认 true
        """
        if reason := self._deny_reason(event):
            return reason
        try:
            if mode == "window" and window:
                data = await self.agent.call("screenshot", mode="window", window=window, max_width=int(self.cfg["screenshot_max_width"]))
            elif mode == "window":
                data = await self.agent.call("screenshot", mode="window", max_width=int(self.cfg["screenshot_max_width"]))
            else:
                data = await self.agent.call("screenshot", mode="screen", max_width=int(self.cfg["screenshot_max_width"]))
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pc_control] screenshot failed: {exc}")
            return self._friendly_error(exc)

        path = data.get("path", "")
        note = ""
        if send_to_user and path:
            try:
                await event.send(MessageChain().file_image(path))
                note = "截图已发到会话里。"
            except Exception as exc:  # noqa: BLE001
                note = f"（发送图片失败：{exc}）"
        return f"截图已保存：{path}（{data.get('width')}x{data.get('height')}）。{note}"

    # ------------------------------------------------------------------ 工具：鼠标

    @llm_tool(name="pc_mouse")
    async def pc_mouse(
        self,
        event: AstrMessageEvent,
        action: str,
        x: int = -1,
        y: int = -1,
        button: str = "left",
        count: int = 1,
        delta: int = -120,
        times: int = 1,
        duration_ms: int = 0,
        to_x: int = -1,
        to_y: int = -1,
    ):
        """控制鼠标。坐标是主显示器的物理像素，原点是左上角。

        Args:
            action(string): move 移动，click 单击，scroll 滚轮，drag 拖拽
            x(int): 目标 X 坐标；click/scroll/move 必填，drag 表示起点
            y(int): 目标 Y 坐标
            button(string): 鼠标键：left、right、middle
            count(int): 点击次数，2 表示双击
            delta(int): 滚轮增量，负数向下滚
            times(int): 滚动格数
            duration_ms(int): 移动/拖拽的耗时毫秒数，0 表示瞬间到位
            to_x(int): drag 的终点 X
            to_y(int): drag 的终点 Y
        """
        if reason := self._deny_reason(event):
            return reason
        try:
            if action == "move":
                if x < 0 or y < 0:
                    return "move 需要 x 和 y。"
                data = await self.agent.call("move", x=x, y=y, duration_ms=max(0, duration_ms))
                return f"鼠标已移动到 {data.get('x')},{data.get('y')}。"
            if action == "click":
                if x < 0 or y < 0:
                    return "click 需要 x 和 y（或用 pc_window 先聚焦窗口后，用 pc_mouse 挪到目标点）。"
                data = await self.agent.call("click", x=x, y=y, button=button, count=max(1, count))
                return f"已在 {data.get('x')},{data.get('y')} 点击 {data.get('count')} 次（{button}）。"
            if action == "scroll":
                args: dict[str, Any] = {"delta": delta, "times": max(1, min(20, times))}
                if x >= 0 and y >= 0:
                    args.update({"x": x, "y": y})
                data = await self.agent.call("scroll", **args)
                return f"滚轮{'上' if int(delta) >= 0 else '下'}滚 {data.get('times')} 格。"
            if action == "drag":
                if min(x, y, to_x, to_y) < 0:
                    return "drag 需要 x、y、to_x、to_y。"
                await self.agent.call("drag", x1=x, y1=y, x2=to_x, y2=to_y, button=button, duration_ms=max(0, duration_ms) or 400)
                return f"已从 {x},{y} 拖到 {to_x},{to_y}。"
            return f"未知动作：{action}（可用 move/click/scroll/drag）。"
        except Exception as exc:  # noqa: BLE001
            return self._friendly_error(exc)

    # ------------------------------------------------------------------ 工具：键盘

    @llm_tool(name="pc_keyboard")
    async def pc_keyboard(
        self,
        event: AstrMessageEvent,
        action: str,
        text: str = "",
        key: str = "",
        keys: str = "",
        times: int = 1,
    ):
        """向当前焦点窗口发送键盘输入。中文和 emoji 直接注入，不依赖输入法。

        Args:
            action(string): type 输入文本，key 按一个键，hotkey 按组合键
            text(string): type 时要输入的文本
            key(string): key 时的键名，如 enter、esc、space、down、f5、a、1
            keys(string): hotkey 用加号连接，如 ctrl+shift+esc
            times(int): 重复次数
        """
        if reason := self._deny_reason(event):
            return reason
        try:
            if action == "type":
                if not text:
                    return "type 需要 text。"
                if len(text) > 2000:
                    return "一次最多输入 2000 个字符。"
                data = await self.agent.call("type", text=text, timeout=15 + len(text) * 0.05)
                return f"已输入 {data.get('chars')} 个字符。"
            if action == "key":
                if not key:
                    return "key 需要 key 名称。"
                data = await self.agent.call("key", key=key, times=max(1, min(20, times)))
                return f"已按 {key} {data.get('times')} 次。"
            if action == "hotkey":
                parts = [part.strip() for part in keys.split("+") if part.strip()]
                if not parts:
                    return "hotkey 需要 keys，例如 ctrl+shift+esc。"
                await self.agent.call("hotkey", keys=parts)
                return f"已按组合键 {'+'.join(parts)}。"
            return f"未知动作：{action}（可用 type/key/hotkey）。"
        except Exception as exc:  # noqa: BLE001
            return self._friendly_error(exc)

    # ------------------------------------------------------------------ 工具：窗口与系统

    @llm_tool(name="pc_window")
    async def pc_window(
        self,
        event: AstrMessageEvent,
        action: str,
        target: str = "",
        text: str = "",
        ms: int = 500,
    ):
        """查看和操作窗口：列出可见窗口、切换前台、启动程序、读写剪贴板、等待、急停。

        Args:
            action(string): list 列窗口，focus 切前台，launch 启动程序，clipboard_get 读剪贴板，clipboard_set 写剪贴板，wait 等待，panic 急停，resume 解除急停，screen_info 屏幕信息
            target(string): focus 时的窗口句柄或标题片段；launch 时的网址/程序路径
            text(string): clipboard_set 要写入的内容
            ms(int): wait 的毫秒数，最大 60000
        """
        if reason := self._deny_reason(event):
            return reason
        try:
            if action == "list":
                rows = await self._windows()
                if not rows:
                    return "没有可见窗口。"
                lines = [
                    f"[{w['hwnd']}] {w.get('title')} {w.get('width')}x{w.get('height')} @{w.get('x')},{w.get('y')}"
                    for w in rows[:40]
                ]
                return f"共 {len(rows)} 个可见窗口：\n" + "\n".join(lines)
            if action == "focus":
                if not target:
                    return "focus 需要 target（窗口句柄或标题片段）。"
                data = await self.agent.call("focus", window=target)
                if data.get("activated"):
                    active = data.get("active") or {}
                    return f"已聚焦「{active.get('title')}」（{active.get('width')}x{active.get('height')}）。"
                return f"Windows 拒绝了聚焦请求，请手动点一下「{(data.get('requested') or {}).get('title')}」再试。"
            if action == "launch":
                if not target:
                    return "launch 需要 target。"
                data = await self.agent.call("launch", target=target)
                return f"已启动 {data.get('target')}。"
            if action == "clipboard_get":
                data = await self.agent.call("clipboard_get")
                return f"剪贴板（{data.get('length')} 字）：\n{data.get('text')}"
            if action == "clipboard_set":
                if not text:
                    return "clipboard_set 需要 text。"
                data = await self.agent.call("clipboard_set", text=text)
                return f"已把 {data.get('length')} 个字写入剪贴板。"
            if action == "wait":
                await self.agent.call("wait", ms=max(0, min(60000, ms)), timeout=ms / 1000 + 15)
                return f"已等待 {ms}ms。"
            if action == "panic":
                await self.agent.call("panic")
                return "急停已生效：之后所有输入都会被拒绝，直到 resume。"
            if action == "resume":
                await self.agent.call("resume")
                return "急停已解除。"
            if action == "screen_info":
                data = await self.agent.call("screen_info")
                return (
                    f"屏幕 {data.get('width')}x{data.get('height')}，显示器 {data.get('monitors')} 个，"
                    f"DPI 感知 {data.get('dpiAware')}，光标在 {(data.get('cursor') or {}).get('x')},{(data.get('cursor') or {}).get('y')}。"
                )
            return f"未知动作：{action}。"
        except Exception as exc:  # noqa: BLE001
            return self._friendly_error(exc)

    # ------------------------------------------------------------------ 工具：抖音

    @llm_tool(name="douyin")
    async def douyin(
        self,
        event: AstrMessageEvent,
        action: str,
        count: int = 5,
        times: int = 1,
        min_dwell_ms: int = 0,
        max_dwell_ms: int = 0,
        like_chance: float = -1.0,
        screenshot_every: int = 0,
    ):
        """刷抖音：打开、看下一个、点赞、批量观看。只对可见的抖音窗口发送真人会做的输入。

        Args:
            action(string): status 查看状态，open 打开网页版，enter 客户端点开第一个视频，next 下一条，prev 上一条，like 点赞，pause 暂停，play 播放，watch 批量观看，stop 急停
            count(int): watch 时看几条，最多 50
            times(int): next/prev 连续切换次数
            min_dwell_ms(int): watch 时每条最短停留毫秒数
            max_dwell_ms(int): watch 时每条最长停留毫秒数
            like_chance(float): watch 时给每条点赞的概率，0 表示不点赞，负数表示用配置值
            screenshot_every(int): 每看几条截一张图发到会话，0 表示不截图
        """
        if reason := self._deny_reason(event):
            return reason
        try:
            if action == "status":
                win = await self._douyin_window()
                if win is None:
                    hidden = await self._douyin_candidates()
                    if hidden:
                        return "抖音窗口存在但不可用（可能被收进悬浮挂件或托盘），请把主窗口点回来再试。"
                    return "没有找到抖音窗口。可以先 douyin(action=open) 打开网页版。"
                kind = "网页版" if self._is_browser(str(win.get("title"))) else "PC 客户端"
                return f"抖音{kind}窗口「{win.get('title')}」{win['width']}x{win['height']} @{win['x']},{win['y']}。"
            if action == "open":
                win = await self._douyin_window()
                if win is not None:
                    await self._focus_douyin()
                    return f"抖音已经打开：{win.get('title')}。"
                await self.agent.call("launch", target=str(self.cfg["douyin_url"]))
                deadline = asyncio.get_running_loop().time() + int(self.cfg["open_timeout_ms"]) / 1000
                while asyncio.get_running_loop().time() < deadline:
                    await self.agent.call("wait", ms=800)
                    found = await self._douyin_window(restore=False)
                    if found is not None:
                        await self._focus_douyin()
                        await self.agent.call("wait", ms=1200)
                        return f"已打开 {self.cfg['douyin_url']} 并聚焦窗口。"
                return "已尝试打开抖音，但没有等到窗口出现（可能还在加载，或被登录页挡住）。可以用 pc_window(action=list) 看看窗口标题。"
            if action == "enter":
                win = await self._focus_douyin()
                x, y = self._point(win, *CLIENT_OPEN_RATIO)
                await self.agent.call("click", x=x, y=y, button="left", count=1)
                await self.agent.call("wait", ms=1800)
                return f"已点开第一张视频卡片（{x},{y}），请用 screenshot 确认进入了播放页。"
            if action in ("next", "prev"):
                win = await self._focus_douyin()
                return await self._swipe(action, times, "", win)
            if action == "like":
                win = await self._focus_douyin()
                if self._is_browser(str(win.get("title"))):
                    x, y = self._point(win, 0.5, 0.55, jitter=0.02)
                    await self.agent.call("click", x=x, y=y, button="left", count=2)
                    how = "双击画面"
                else:
                    x = int(win["x"] + win["width"] - CLIENT_RAIL_RIGHT_PX)
                    y = int(win["y"] + win["height"] * CLIENT_LIKE_RATIO)
                    await self.agent.call("click", x=x, y=y, button="left", count=1)
                    how = "点右侧红心"
                await self.agent.call("wait", ms=400)
                return f"已点赞（{how}，{x},{y}）。截图确认一下比较稳妥。"
            if action in ("pause", "play"):
                await self._focus_douyin()
                await self.agent.call("key", key="space", times=1)
                return "已按空格暂停/播放。"
            if action == "stop":
                await self.agent.call("panic")
                return "已急停：之后所有鼠标键盘输入都会被拒绝，直到 pc_window(action=resume)。"
            if action == "watch":
                return await self._watch(event, count, min_dwell_ms, max_dwell_ms, like_chance, screenshot_every)
            return f"未知动作：{action}。"
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[pc_control] douyin {action} failed: {exc}")
            return self._friendly_error(exc)

    async def _watch(
        self,
        event: AstrMessageEvent,
        count: int,
        min_dwell_ms: int,
        max_dwell_ms: int,
        like_chance: float,
        screenshot_every: int,
    ):
        count = max(1, min(50, int(count or self.cfg["max_watch_count"])))
        low = max(600, int(min_dwell_ms or self.cfg["min_dwell_ms"]))
        high = max(low, int(max_dwell_ms or self.cfg["max_dwell_ms"]))
        chance = float(like_chance if like_chance >= 0 else self.cfg["like_chance"])
        max_likes = max(0, int(self.cfg["max_likes_per_run"]))

        win = await self._douyin_window()
        if win is None:
            return "没有可用的抖音窗口。先 douyin(action=open) 或把客户端主窗口恢复。"
        kind = "网页版" if self._is_browser(str(win.get("title"))) else "PC 客户端"

        watched = 0
        liked = 0
        stopped = ""
        for index in range(count):
            try:
                win = await self._focus_douyin()
                await self.agent.call("wait", ms=random.randint(low, high), timeout=high / 1000 + 15)
                if chance > 0 and liked < max_likes and random.random() < chance:
                    if self._is_browser(str(win.get("title"))):
                        x, y = self._point(win, 0.5, 0.55, jitter=0.02)
                        await self.agent.call("click", x=x, y=y, button="left", count=2)
                    else:
                        x = int(win["x"] + win["width"] - CLIENT_RAIL_RIGHT_PX)
                        y = int(win["y"] + win["height"] * CLIENT_LIKE_RATIO)
                        await self.agent.call("click", x=x, y=y, button="left", count=1)
                    liked += 1
                    await self.agent.call("wait", ms=400)
                if screenshot_every > 0 and index % screenshot_every == 0:
                    data = await self.agent.call("screenshot", mode="window", window=str(win["hwnd"]), max_width=int(self.cfg["screenshot_max_width"]))
                    try:
                        await event.send(MessageChain().file_image(data["path"]))
                    except Exception:  # noqa: BLE001
                        pass
                await self._swipe("next", 1, "", win)
                watched += 1
            except PcAgentError as exc:
                if exc.code == "KILL_SWITCH":
                    stopped = "被急停中断"
                    break
                raise

        tail = f"，{stopped}" if stopped else ""
        return f"在抖音{kind}上看了 {watched} 条视频，点赞 {liked} 次{tail}。"
