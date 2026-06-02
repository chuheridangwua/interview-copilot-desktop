# Interview Copilot Desktop 交接文档

当前项目已经从 Tauri 迁移为 Electron + React。Windows 本机继续开发不再需要 Rust/Cargo。

## 开发记录要求

后续每次做较大功能改动、模型/ASR 调优、真实面试测试、构建失败定位或关键问题修复，都要更新：

```text
docs/DEVELOPMENT_LOG.md
```

记录至少包含：时间、目标、已完成、验证结果、已知问题、下一步。不要把真实 API Key 写入任何文档。

## 当前目标

做一个 Windows 桌面客户端，用于真实面试时监听系统输出声音，将面试官问题送到豆包/火山引擎流式 ASR，并从内置问题库中匹配 Top 3 问题和答案。

核心约束：

- 只监听系统声音，不采集麦克风。
- 问题库内置到客户端，不读取 Windows 本地 Markdown。
- 本地毫秒级匹配优先，小模型后台确认问题、重排候选，并为每个 final 问题生成流式口述稿。
- 面试会话流程：开始面试 -> 暂停面试 -> 继续面试 -> 结束面试。
- 空格快捷键：未开始时开始、进行中暂停、暂停中继续。
- API Key 不写入仓库和文档；当前 ASR Key 仍从环境变量读取。
- 调试日志固定写入项目根目录 `logs/`，该目录已加入 `.gitignore`。
- `resources/jianli.md` 用作模型口述稿上下文，只保留经历、项目、技能和成果，不提交手机号、邮箱、QQ 等个人联系方式。

## 技术栈

- Electron main process：窗口、IPC、豆包 ASR WebSocket、题库解析、匹配事件分发。
- Electron preload：调用 `getDisplayMedia` 获取系统音频，转成 `16kHz / 16bit / mono / PCM`，按 200ms 分包发给 main process。
- React/Vite/TypeScript：桌面控制台 UI。
- 火山方舟 Ark Chat API：后台短 JSON 任务用于问题确认和题库候选重排，流式任务用于生成模型口述稿。
- electron-builder：Windows `.exe` / `.msi` 打包。

## 关键文件

```text
package.json
README.md
.github/workflows/build-windows-client.yml
resources/question_bank_embedded.md
resources/icon.ico
electron/main.cjs
electron/preload.cjs
electron/backend/doubaoAsr.cjs
electron/backend/questionMatcher.cjs
electron/backend/arkQuestionEnhancer.cjs
scripts/electron-dev.cjs
scripts/test-question-matcher.mjs
scripts/test-asr-config.mjs
scripts/test-ark-speed.cjs
scripts/build-windows.ps1
src/App.tsx
src/desktopClient.ts
src/styles.css
docs/DEVELOPMENT_LOG.md
```

`src-tauri/` 目录暂时保留为历史实现参考，不再参与 npm 脚本和 GitHub Actions 打包。

## Windows 本机开发

Windows 只需要 Node/npm：

```powershell
node -v
npm -v
```

配置 ASR Key：

```powershell
setx DOUBAO_API_KEY "你的新Key"
```

可选配置方舟小模型 Key：

```powershell
setx ARK_API_KEY "你的ArkKey"
setx ARK_MODEL "doubao-seed-2-0-mini-260428"
```

执行 `setx` 后重新打开 PowerShell 或重启客户端。

启动开发客户端：

```powershell
cd E:\CLX\project\interview-copilot-desktop
npm install
npm run client
```

打安装包：

```powershell
npm run client:build
```

或：

```powershell
.\scripts\build-windows.ps1
```

产物位置：

```text
release/*.exe
release/*.msi
```

## Linux Remote SSH 开发

Linux 远程环境可用于写代码、跑前端和匹配测试：

```bash
cd /home/ubuntu/offer/interview-copilot-desktop
npm install
npm run dev
npm run test:matcher
npm run test:ark-speed
npm run build
```

`npm run dev` 只是 Vite 前端，不是桌面端。浏览器里提示“未检测到 Electron 桌面端后端”是正常的。

如果 Linux 有图形桌面，可尝试：

```bash
npm run client
```

但真实系统声音采集必须在 Windows 本机验证。

## 已验证

在 Linux 上已通过：

```bash
npm run test:matcher
npm run build
npx electron-builder --dir --linux dir
npm ci --dry-run --no-audit --no-fund
```

`npx electron-builder --dir --linux dir` 只验证 Electron 打包配置，不代表 Windows 系统声音已验证。

## 真实端到端待验证

需要在 Windows 本机继续验证：

- Electron `getDisplayMedia` 是否能稳定拿到系统 loopback 音频。
- 顶部音量是否随会议声音变化。
- PCM 发送豆包 ASR 后是否持续返回 partial/final。
- 开始/暂停/继续/结束面试流程是否符合真实面试节奏。
- 小模型后台确认/重排是否在真实音频下能稳定 1 秒级返回。
- `.exe` / `.msi` 安装包运行是否能读取环境变量。

## 使用流程

1. 打开会议软件并让面试官声音从 Windows 系统输出设备播放。
2. 启动客户端：`npm run client`。
3. 按空格或点击 `开始面试`。
4. Electron 会请求屏幕/系统音频捕获权限，选择屏幕并允许系统音频。
5. 状态栏音量不是 0%，说明采到了声音。
6. 顶部状态胶囊会显示音频、ASR、题库、简历、AI 自检状态。
7. 面试官说完一段问题后，左侧问题列表新增记录，中间出 Top 3，右侧出题库答案和模型口述稿。
8. 右侧语音识别列上方显示实时识别，下方按时间倒序显示完整重写内容。
9. 按空格可在运行和暂停之间切换；点击 `结束面试` 会停止采集并保留本场结果。

## 调试日志

项目根目录会固定写入：

```text
logs/debug-YYYY-MM-DD.jsonl
logs/session-YYYY-MM-DD.jsonl
logs/model-YYYY-MM-DD.jsonl
```

用途：

- `debug-*`：ASR final、问题推断、跳过原因、健康检查。
- `session-*`：面试会话状态日志。
- `model-*`：方舟问题确认、候选重排、模型口述稿流式状态和耗时。

日志不写 API Key，但可能包含 ASR 文本和问题内容，不要提交。

## 安全事项

不要把 Key 写入：

- 代码
- README
- `.env`
- GitHub Actions
- 日志
- `docs/DEVELOPMENT_LOG.md`

当前 ASR 代码读取：

```text
DOUBAO_API_KEY
VOLCENGINE_ASR_API_KEY
```

当前方舟小模型代码读取：

```text
ARK_API_KEY
VOLCENGINE_ARK_API_KEY
DOUBAO_ARK_API_KEY
ARK_MODEL
ARK_FAST_MODEL
```
