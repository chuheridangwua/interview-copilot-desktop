# Interview Copilot Desktop 本地 Codex 交接文档

本文档用于把当前工作完整交接给 Windows 本地环境中的 Codex/开发者继续处理。当前项目路径：

```text
/home/ubuntu/offer/interview-copilot-desktop
```

如果已经下载到 Windows，本地路径示例：

```text
E:\CLX\project\interview-copilot-desktop
```

## 1. 产品目标

要做的是一个 Windows 桌面客户端，不是网页应用。

核心目标：

- 只识别系统输出声音，不识别麦克风。
- 系统声音来自腾讯会议、飞书会议、Zoom、Teams 等桌面会议软件里的面试官声音。
- 将系统声音流式送到豆包/火山引擎大模型流式 ASR。
- 根据识别文本，从本地 Markdown 问题库里匹配最相关的 3 个问题。
- 桌面端全屏控制台展示：
  - 实时转写
  - Top 3 候选问题
  - 当前完整原文答案
  - 命中词高亮
  - 暂停匹配、锁定答案、手动搜索等控制

原始问题库默认路径：

```text
/home/ubuntu/offer/面试可能遇到的问题清单.md
```

Windows 上需要改成实际路径，例如：

```text
D:\offer\面试可能遇到的问题清单.md
```

## 2. 当前实现状态

当前已经完成一个 Tauri + React 桌面端项目骨架。

已完成：

- React/Vite/TypeScript 前端控制台。
- Tauri v2 项目结构。
- 本地 Markdown 问题库解析。
- 本地 Top 3 匹配算法。
- 豆包 ASR 二进制 WebSocket 协议封包和解包基础实现。
- Windows 音频采集模块结构，目标是 WASAPI loopback。
- 虚拟声卡兜底设备枚举逻辑。
- Tauri commands 接口。
- 会话状态管理。
- 可选保存音频和日志。
- Windows 一键构建脚本。
- GitHub Actions Windows 构建工作流，但用户表示可以不用 GitHub。

当前未完成或未验证：

- Windows 本机真实编译尚未完成。
- Windows WASAPI loopback 真实采集尚未验证。
- 豆包 ASR 真实连接尚未验证。
- `.exe` / `.msi` 安装包尚未在 Windows 上打出。
- Windows 安装后的完整端到端链路尚未验证。

原因：

- 当前远程开发环境是 Linux。
- 该 Linux 环境不能验证 Windows WASAPI 系统声音采集。
- 用户 Windows 电脑目前已经有 Node/npm，但还没有安装 Rust/Cargo。

## 3. 当前用户 Windows 环境状态

用户在 Windows PowerShell 中运行过：

```powershell
node -v
npm -v
rustc --version
cargo --version
```

输出：

```text
v22.18.0
11.5.2
rustc: command not found
cargo: command not found
```

结论：

- Node.js 已安装。
- npm 已安装。
- Rust 未安装。
- Cargo 未安装。

下一步必须先安装 Rust。

Rust 安装地址：

```text
https://rustup.rs/
```

安装后必须关闭并重新打开 PowerShell，再检查：

```powershell
rustc --version
cargo --version
```

如果后续出现 `link.exe not found` 或 MSVC 相关错误，需要安装 Visual Studio Build Tools：

```text
https://visualstudio.microsoft.com/visual-cpp-build-tools/
```

安装时勾选：

```text
Desktop development with C++
```

建议包含：

```text
MSVC v143
Windows 10/11 SDK
C++ CMake tools for Windows
```

## 4. 关键命令

Linux 开发环境中可运行：

```bash
cd /home/ubuntu/offer/interview-copilot-desktop
npm install
npm run test:matcher
npm run build
```

Windows 本地环境中构建客户端：

```powershell
cd E:\CLX\project\interview-copilot-desktop
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
```

Windows 本地启动开发版客户端：

```powershell
npm run client
```

Windows 本地打正式安装包：

```powershell
npm run client:build
```

不要在 Linux 上运行：

```bash
npm run tauri -- dev
```

因为第一版客户端依赖 Windows WASAPI loopback，Linux 上不能验证真实系统声音采集。

## 5. 已验证结果

在 Linux 环境已验证：

```bash
npm run test:matcher
```

通过。测试结果覆盖：

- 输入 `你们的 RAG 是怎么做的，复杂 PDF 和表格怎么处理`，命中 #24。
- 输入 `Agent、Workflow、MCP、Function Calling 区别是什么`，命中 #25。
- 输入 `为什么离开国企`，命中 #4。
- 输入 `期望薪资是多少`，命中 #5。
- 输入 `你们 badcase 怎么反馈和迭代`，应包含 #9 或 #17。

在 Linux 环境已验证：

```bash
npm run build
```

通过。Vite 前端构建正常。

在 Linux 环境已验证：

```bash
npm run client
```

会给出明确提示：当前是 Linux，不能启动 Windows 客户端。这个行为是故意的，避免用户误以为要打开网页。

## 6. 重要安全事项

用户之前在聊天里贴过豆包 API Key。该 Key 已经暴露。

后续必须提醒用户：

- 去火山/豆包控制台轮换新 Key。
- 不要把 Key 写入代码。
- 不要把 Key 写入 README。
- 不要把 Key 提交到 Git。
- 运行时在客户端输入 Key，或在 Windows PowerShell 设置环境变量。

环境变量方式：

```powershell
$env:DOUBAO_API_KEY="新的Key"
```

或：

```powershell
$env:VOLCENGINE_ASR_API_KEY="新的Key"
```

## 7. 项目结构

核心文件：

```text
package.json
README.md
scripts/test-question-matcher.mjs
scripts/check-client-env.mjs
scripts/build-windows.ps1
src/App.tsx
src/styles.css
src/tauriClient.ts
src-tauri/Cargo.toml
src-tauri/tauri.conf.json
src-tauri/src/lib.rs
src-tauri/src/main.rs
src-tauri/src/audio.rs
src-tauri/src/doubao.rs
src-tauri/src/matcher.rs
src-tauri/src/question_bank.rs
src-tauri/src/session.rs
```

各文件作用：

- `src/App.tsx`：桌面控制台 UI。
- `src/styles.css`：控制台样式。
- `src/tauriClient.ts`：前端调用 Tauri command 和事件监听。
- `src-tauri/src/lib.rs`：Tauri command 注册、会话状态、启动/停止逻辑。
- `src-tauri/src/audio.rs`：Windows 系统声音采集入口；非 Windows 返回明确错误。
- `src-tauri/src/doubao.rs`：豆包流式 ASR 二进制协议封装与解析。
- `src-tauri/src/matcher.rs`：本地问题匹配算法。
- `src-tauri/src/question_bank.rs`：Markdown 问题库解析。
- `src-tauri/src/session.rs`：ASR 会话、转写事件、匹配事件和日志保存。
- `scripts/build-windows.ps1`：Windows 一键构建脚本。
- `scripts/check-client-env.mjs`：检查是否在 Windows 且 Rust/Cargo 可用。
- `scripts/test-question-matcher.mjs`：Node 侧匹配测试。

## 8. Tauri commands

前端当前依赖这些 command：

```text
list_audio_sources()
start_session(settings)
stop_session()
pause_matching()
resume_matching()
lock_answer(questionId)
unlock_answer()
search_questions(query)
```

前端监听这些事件：

```text
audio_status
asr_partial
asr_final
match_candidates
session_log
```

## 9. 客户端配置字段

前端启动会传入：

```ts
{
  doubaoApiKey?: string,
  resourceId: string,
  captureMode: "wasapi_loopback" | "virtual_audio_device",
  audioDeviceId?: string,
  saveAudio: boolean,
  questionBankPath: string
}
```

Rust 侧对应 `SessionSettings`。

默认 Resource ID：

```text
volc.seedasr.sauc.duration
```

如果用户开通的是并发版，改为：

```text
volc.seedasr.sauc.concurrent
```

## 10. 豆包 ASR 当前设计

目标接口：

```text
wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
```

当前 `doubao.rs` 中实现：

- `build_full_client_request`
- `build_audio_request`
- `build_last_audio_request`
- `parse_server_frame`
- gzip 压缩和解压
- full server response JSON 解析
- transcript 提取

当前 full client request 关键参数：

```json
{
  "audio": {
    "format": "pcm",
    "codec": "raw",
    "rate": 16000,
    "bits": 16,
    "channel": 1
  },
  "request": {
    "model_name": "bigmodel",
    "enable_nonstream": true,
    "enable_itn": true,
    "enable_punc": true,
    "enable_ddc": false,
    "show_utterances": true,
    "result_type": "full",
    "end_window_size": 800
  }
}
```

热词包含：

```text
AI产品经理
RAG
Agent
Workflow
MCP
Function Calling
badcase
MVP
AI中台
合同评审
投标评审
商机推送
复杂PDF
知识库
```

本地 Codex 后续需要重点验证：

- 豆包 header 是否完全符合当前账号版本要求。
- `X-Api-Resource-Id` 是否使用正确版本。
- `X-Api-Sequence` 是否需要只在握手 header 里固定为 `-1`。
- full client request gzip + JSON 格式是否被豆包接受。
- audio-only request 的 sequence / negative packet 实现是否符合豆包文档。

## 11. 音频采集当前设计

目标：

- 不采麦克风。
- 只采系统输出声音。
- Windows 主路径：WASAPI loopback。
- 兜底路径：虚拟声卡，例如 VB-CABLE / Voicemeeter。
- 输出到 ASR 前统一为：

```text
16000 Hz
16 bit
mono
PCM
200ms per packet
```

当前文件：

```text
src-tauri/src/audio.rs
```

注意：

- Linux 分支只是返回明确错误。
- Windows 分支还没有在真实 Windows 环境编译验证。
- 如果 Windows 编译失败，需要优先修 `wasapi` crate API 兼容问题。
- 如果编译通过但采不到声音，需要检查 WASAPI loopback 初始化方向、设备选择和数据格式转换。

本地 Codex 应优先在 Windows 上跑：

```powershell
npm run client
```

并观察：

- 能否列出音频设备。
- 能否启动窗口。
- 点击开始监听后是否有音量事件。
- 腾讯会议/飞书会议/Zoom 播放声音时是否有 PCM 数据。

## 12. 匹配算法当前状态

文件：

```text
src-tauri/src/matcher.rs
scripts/test-question-matcher.mjs
```

策略：

- 解析 Markdown 中 `^\d+\.\s+` 的编号问题。
- 每条问题常驻内存。
- 不实时调用大模型。
- 中文字符、二元/三元片段、英文 token 混合匹配。
- curated hints 提升特定问题命中率。

目前重点优化对象：

- #24 RAG
- #25 Agent / Workflow / MCP / Function Calling
- #9 / #17 badcase
- #4 离开国企
- #5 薪资
- #20 合同/投标评审

后续可优化：

- 增加更多 curated hints。
- 增加问题同义问法表。
- 让 Top 3 更好处理复合问题。
- 在 UI 上显示匹配原因和命中词已经有基础。

## 13. UI 当前状态

文件：

```text
src/App.tsx
src/styles.css
```

布局：

- 顶部状态栏。
- 配置栏：
  - API Key
  - Resource ID
  - 问题库路径
  - 采集模式
  - 音频设备
  - 是否保存
  - 开始/停止
  - 暂停匹配
  - 锁定答案
- 左侧：实时转写。
- 中间：Top 3 候选 + 手动搜索。
- 右侧：完整原文答案 + 高亮。
- 底部：设备和会话日志。

注意：

- UI 是桌面端控制台，不是给浏览器网站使用。
- `npm run dev` 只是 Tauri 开发时内部加载 UI 的方式，不是产品入口。
- 产品入口应是 Windows 上的 `.exe` / `.msi` 或 `npm run client`。

## 14. 可选保存当前设计

默认不保存音频。

用户手动开启保存后，创建：

```text
sessions/<session-id>/
```

写入：

```text
system-audio.pcm
transcript.jsonl
matches.jsonl
```

`system-audio.pcm` 格式：

```text
16kHz / 16bit / mono / PCM
```

本地 Codex 后续需要验证：

- Windows 下目录是否正确创建。
- PCM 是否真的写入。
- JSONL 是否跟 ASR 事件一致。
- 保存关闭时不应落盘音频。

## 15. 已知风险和可能需要修的点

### 15.1 Rust/Cargo 未安装

用户当前 Windows 机器缺 Rust/Cargo。必须先解决。

### 15.2 WASAPI crate API 可能需要调整

当前 Windows 音频采集代码按照 `wasapi` crate 设计，但未在 Windows 编译。第一次 `npm run client` 或 `npm run client:build` 可能出现 Rust 编译错误。

如果出现 Rust 编译错误，本地 Codex 应优先修：

```text
src-tauri/src/audio.rs
```

### 15.3 豆包 WebSocket 协议需要真实联调

当前协议封装基于用户贴出的文档，但没有真实请求验证。可能需要修：

```text
src-tauri/src/doubao.rs
src-tauri/src/session.rs
```

重点检查：

- Header 名大小写。
- Resource ID。
- gzip 压缩要求。
- sequence flag。
- last packet 格式。
- response payload JSON 结构。

### 15.4 前端和 Rust 字段命名

前端用 camelCase，Rust 用 serde camelCase。若调用失败，检查：

```text
doubaoApiKey <-> doubao_api_key
resourceId <-> resource_id
captureMode <-> capture_mode
audioDeviceId <-> audio_device_id
saveAudio <-> save_audio
questionBankPath <-> question_bank_path
```

### 15.5 问题库路径

Linux 默认路径在 Windows 上无效。用户必须在 Windows UI 中填实际路径。

建议后续优化：

- 客户端打包时内置一份默认问题库。
- 或者第一次启动让用户选择文件。

## 16. 下一步建议优先级

### P0：安装 Rust 并让 Windows 编译通过

用户下一步：

```powershell
rustc --version
cargo --version
```

确认可用后：

```powershell
cd E:\CLX\project\interview-copilot-desktop
npm run client
```

如果编译报错，把完整错误交给本地 Codex。

### P0：修 Windows 音频模块编译错误

优先文件：

```text
src-tauri/src/audio.rs
```

目标：

- 能列出输出设备。
- 能启动 WASAPI loopback。
- 能持续产生 200ms PCM chunk。

### P0：真实连接豆包 ASR

目标：

- API Key 正常鉴权。
- 能收到 partial/final 转写。
- ASR 事件进入 UI。

### P1：端到端联调

流程：

1. 打开会议软件或播放一段中文音频。
2. 客户端选择系统声音设备。
3. 点击开始监听。
4. 左侧出现实时转写。
5. 中间出现 Top 3。
6. 右侧答案刷新。
7. 暂停匹配有效。
8. 锁定答案有效。

### P1：打安装包

运行：

```powershell
npm run client:build
```

或：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows.ps1
```

找到：

```text
src-tauri\target\release\bundle\msi\*.msi
src-tauri\target\release\bundle\nsis\*.exe
```

### P2：用户体验优化

- 文件选择器选择问题库。
- API Key 使用系统凭据保存。
- 添加“一键测试 ASR”按钮。
- 添加“一键测试音频输入”按钮。
- 添加“模拟输入文本”调试模式。
- 增加悬浮窗或侧边窗。

## 17. 本地 Codex 接手时的推荐提示词

可以把下面这段交给 Windows 本地 Codex：

```text
请继续处理 E:\CLX\project\interview-copilot-desktop 这个 Tauri + React Windows 桌面客户端项目。

请先阅读 docs\LOCAL_CODEX_HANDOFF.md，然后执行：

node -v
npm -v
rustc --version
cargo --version
npm install
npm run test:matcher
npm run build
npm run client

如果 npm run client 出现 Rust 编译错误，优先修 src-tauri\src\audio.rs 的 Windows WASAPI loopback 采集实现。

目标是让 Windows 桌面客户端启动，并能只采集系统输出声音，不采麦克风；之后接通豆包流式 ASR，实时匹配问题库 Top 3。

不要把豆包 API Key 写入代码或提交到仓库。
```

## 18. 备注

当前仓库根目录还存在一些和本任务无关的文件变更或未跟踪文件，例如：

```text
面试可能遇到的问题清单.md
interview_common_questions_labeled*.md
```

这些不是本次客户端实现的核心文件。不要误删，也不要随便覆盖。

本次客户端项目核心在：

```text
interview-copilot-desktop/
```

