# Interview Copilot Desktop

Windows 桌面端实时面试答案匹配器。第一版只支持 Windows 客户端运行，Linux 适合作为开发环境和提交代码环境。

## 核心能力

- 只采集系统输出声音，不采集麦克风。
- 通过豆包/火山引擎流式 ASR 识别面试官声音。
- 问题清单已内置到客户端安装包，不依赖 Windows 本地 Markdown 路径。
- 本地毫秒级匹配 Top 3 问题，不实时调用大模型做匹配。
- 普通可缩放桌面窗口展示实时转写、Top 3 候选和完整原文答案。

## API Key 安全

不要把 API Key 写进代码、配置文件或 GitHub 仓库。

客户端不在页面里展示或保存 API Key，只从 Windows 运行时环境变量读取：

```powershell
$env:DOUBAO_API_KEY="你的新Key"
```

或：

```powershell
$env:VOLCENGINE_ASR_API_KEY="你的新Key"
```

如果 Key 曾经发到聊天里，请先去火山/豆包控制台轮换新 Key。

## Linux 开发方式

Linux 上可以做代码开发、前端构建和匹配测试：

```bash
npm install
npm run test:matcher
npm run build
```

不要在 Linux 上运行下面这个命令：

```bash
npm run tauri -- dev
```

原因：这个项目第一版的系统声音采集走 Windows WASAPI loopback，客户端必须在 Windows 环境启动。

如果你误运行了，可以改用更明确的客户端入口：

```bash
npm run client
```

在 Linux 上它会直接提示当前系统不能启动 Windows 客户端。

## 推荐工作流：Linux 开发，GitHub Actions 打 Windows 安装包

这是你当前最适合的方式：

1. 在 Linux 上开发和测试：

```bash
npm install
npm run test:matcher
npm run build
```

2. 把 `interview-copilot-desktop` 作为一个单独 GitHub 仓库推上去。

3. 打开 GitHub 仓库的 `Actions` 页面。

4. 选择 `Build Windows Client`。

5. 点击 `Run workflow`。

6. 等构建完成后，在 workflow run 页面下载 artifact：

```text
interview-copilot-windows
```

7. artifact 里会包含 Windows 客户端安装包，通常在：

```text
src-tauri/target/release/bundle/msi/*.msi
src-tauri/target/release/bundle/nsis/*.exe
```

8. 把 `.exe` 或 `.msi` 下载到 Windows 电脑安装使用。

项目已经包含 GitHub Actions 工作流：

```text
.github/workflows/build-windows-client.yml
```

这个工作流会在 `windows-latest` 上执行：

```bash
npm ci
npm run test:matcher
npm run build
npm run tauri -- build
```

然后上传 Windows 安装包 artifact。

## Windows 本地运行方式

如果你也想在 Windows 上本地开发或调试客户端，需要先安装：

- Node.js
- Rust / Cargo：https://rustup.rs/
- Microsoft Visual Studio Build Tools，勾选 `Desktop development with C++`
- Microsoft Edge WebView2 Runtime

然后在 Windows PowerShell 中运行：

```powershell
npm install
npm run client
```

构建安装包：

```powershell
npm run client:build
```

## 使用客户端

1. 打开腾讯会议、飞书会议、Zoom 或 Teams。
2. 确认面试官声音能从耳机或扬声器正常播放。
3. 在 Windows 用户环境变量里提前设置 `DOUBAO_API_KEY`，然后重新打开客户端。
4. 启动 Interview Copilot 客户端。
5. `Resource ID` 默认使用：

```text
volc.seedasr.sauc.duration
```

如果你的账号开通的是并发版，改成：

```text
volc.seedasr.sauc.concurrent
```

6. 问题库已经内置，不需要选择或填写本地文件路径。
7. 采集模式优先选择：

```text
WASAPI 系统声音
```

8. 音频设备选择会议软件实际输出的设备，开始后看状态栏音量百分比；如果一直是 0%，说明选错输出设备或会议声音没有从该设备播放。
9. 点击 `开始监听`。
10. 如果答案正确，点击 `锁定`，避免后续闲聊或追问刷新答案。
11. 如果暂时不想刷新答案，点击 `暂停匹配`。
12. 如果 ASR 识别错了，用手动搜索框搜索关键词，如 `RAG`、`badcase`、`薪资`、`离开国企`。

## 虚拟声卡兜底

如果 WASAPI 采不到会议声音，可以安装 VB-CABLE 或 Voicemeeter：

1. 把会议软件输出设备设置为虚拟声卡。
2. 在客户端里把采集模式切到 `虚拟声卡`。
3. 选择对应虚拟声卡设备。

## 可选保存

默认不保存音频。

手动开启保存后，会生成：

```text
sessions/<session-id>/system-audio.pcm
sessions/<session-id>/transcript.jsonl
sessions/<session-id>/matches.jsonl
```

`system-audio.pcm` 是原始 PCM：16 kHz、16-bit、mono。
