# Interview Copilot Desktop

Electron + React 桌面端实时面试答案匹配器。当前目标是 Windows 本机真实面试使用；Linux 远程环境适合写代码、调前端、跑匹配测试。

## 核心能力

- 只采集系统输出声音，不采集麦克风。
- 通过豆包/火山引擎流式 ASR 识别面试官声音。
- 问题清单已内置到客户端安装包，不依赖 Windows 本地 Markdown 路径。
- 本地毫秒级匹配 Top 3 问题，不实时调用大模型做匹配。
- 普通可缩放桌面窗口展示问题列表、实时转写、Top 3 候选和完整原文答案。
- 空格推进流程：开始监听 -> 锁定答案 -> 清空进入下一题。

## API Key 安全

不要把 API Key 写进代码、配置文件或 GitHub 仓库。

客户端不在页面里展示或保存 API Key，只从运行时环境变量读取：

```powershell
setx DOUBAO_API_KEY "你的新Key"
```

或：

```powershell
setx VOLCENGINE_ASR_API_KEY "你的新Key"
```

执行 `setx` 后要重新打开 PowerShell 或重新启动客户端。曾经发到聊天里的 Key 请先去火山/豆包控制台轮换。

## Linux Remote SSH 开发

在 Linux 远程服务器上可以做代码开发、前端预览、匹配测试和生产前端构建：

```bash
npm install
npm run dev
npm run test:matcher
npm run build
```

`npm run dev` 只启动 Vite 前端。用 VSCode Remote SSH 转发 `1420` 端口后，可以在 Windows 浏览器打开：

```text
http://127.0.0.1:1420
```

这个页面不是桌面客户端，所以会提示“未检测到 Electron 桌面端后端”。这是正常的，只能用于看布局和前端样式。

Linux 如果有图形桌面，也可以尝试启动 Electron 壳：

```bash
npm run client
```

但真实系统声音采集仍建议在 Windows 本机验证，因为面试声音实际在 Windows 音频会话里。

## Windows 本机开发

Windows 现在不需要 Rust/Tauri。需要安装：

- Node.js 22 或 LTS
- npm
- Microsoft Edge WebView2 Runtime，通常 Windows 已内置

启动开发客户端：

```powershell
cd E:\CLX\project\interview-copilot-desktop
npm install
npm run client
```

构建 Windows 安装包：

```powershell
npm run client:build
```

或运行 PowerShell 脚本：

```powershell
.\scripts\build-windows.ps1
```

构建产物在：

```text
release/*.exe
release/*.msi
```

## 推荐工作流

1. Linux Remote SSH 写代码和调前端：

```bash
cd /home/ubuntu/offer/interview-copilot-desktop
npm run dev
npm run test:matcher
npm run build
```

2. 提交推送到 GitHub：

```bash
git add .
git commit -m "..."
git push
```

3. Windows 本机拉最新代码并调真实客户端：

```powershell
cd E:\CLX\project\interview-copilot-desktop
git pull
npm install
npm run client
```

4. GitHub Actions 自动打包 Windows 安装包，artifact 名称：

```text
interview-copilot-windows
```

## 使用客户端

1. 打开腾讯会议、飞书会议、Zoom 或 Teams。
2. 确认面试官声音能从耳机或扬声器正常播放。
3. 设置 `DOUBAO_API_KEY` 环境变量并重新打开客户端。
4. 启动 Interview Copilot。
5. `Resource ID` 默认使用：

```text
volc.seedasr.sauc.duration
```

如果你的账号开通的是并发版，改成：

```text
volc.seedasr.sauc.concurrent
```

6. 点击或按空格开始监听。
7. Electron 会请求系统声音/屏幕捕获权限。请选择屏幕并允许系统音频。
8. 状态栏音量不是 0%，说明采到了系统声音。
9. 面试官说完一段问题后，左侧新增问题记录，中间显示 Top 3，右侧显示答案。
10. 再按空格锁定答案，后续转写不会覆盖右侧答案。
11. 再按空格清空当前题，进入下一题。

## 可选保存

默认不保存音频。

手动开启保存后，会写入 Electron 用户数据目录下的会话目录：

```text
sessions/<session-id>/system-audio.pcm
sessions/<session-id>/transcript.jsonl
sessions/<session-id>/matches.jsonl
```

`system-audio.pcm` 是原始 PCM：16 kHz、16-bit、mono。

## 当前实现说明

- 运行壳已迁移到 Electron。
- React UI 和本地匹配逻辑保留。
- Electron main process 负责豆包 ASR WebSocket、问题库解析、匹配事件分发。
- Electron preload 负责调用 `getDisplayMedia` 获取系统音频并转成 `16kHz / 16bit / mono / PCM`，按 200ms 分包发给 main process。
- Windows 真实系统音频采集需要在 Windows 本机继续实测和调优。
