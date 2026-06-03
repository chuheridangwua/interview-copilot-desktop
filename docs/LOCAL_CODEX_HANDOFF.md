# Interview Copilot Desktop 交接文档

当前项目已经从 Tauri 迁移为 Electron + React。Windows 本机继续开发不再需要 Rust/Cargo。

## 开发记录要求

后续每次做较大功能改动、模型/ASR 调优、真实面试测试、构建失败定位或关键问题修复，都要更新：

```text
docs/DEVELOPMENT_LOG.md
```

记录至少包含：时间、目标、已完成、验证结果、已知问题、下一步。不要把真实 API Key 写入任何文档。

## 当前目标

做一个 Windows 桌面客户端，用于真实面试时监听系统输出声音，将面试官问题送到豆包/火山引擎流式 ASR，并从内置问题库和可选公司题库中匹配候选问题和答案。

核心约束：

- 系统声音用于识别面试官问题；麦克风只作为模型口述稿的最近对话上下文，不生成题目、不参与 matcher。
- 通用问题库内置到客户端；面试前可选 `resources/company/<公司名>` 下的公司资料和公司题库。
- 手动标记是当前推荐主路径：运行中点击 `标记问题` 或按 `M` 开始，再次点击或按 `M` 结束；提交时会取开始前 10 秒到结束之间的系统 ASR 文本，重组问题、匹配题库并生成流式口述稿。
- 自动抽题作为实时预览和未手动时的兜底；手动标记期间自动 final/update 不写入历史、不触发答案，结束后仍会按标记窗口屏蔽晚到的自动 final。
- 面试会话流程：开始面试 -> 暂停面试 -> 继续面试 -> 结束面试。
- 空格快捷键：未开始时开始、进行中暂停、暂停中继续。
- `M` 快捷键：运行中开始/结束手动标记；输入框、select、textarea、contenteditable 聚焦时不触发。
- API Key 不写入仓库和文档；当前 ASR Key 仍从环境变量读取。
- 调试日志固定写入项目根目录 `logs/`，该目录已加入 `.gitignore`。
- 每场面试都会自动归档到项目根目录的 `sessions/YYYY-MM-DD_HH-mm-ss_<session-id>/`，用于保存音频、转写、问题列表、题库答案和 AI 答案；该目录已加入 `.gitignore`。
- `resources/jianli.md` 用作模型口述稿上下文，只保留经历、项目、技能和成果，不提交手机号、邮箱、QQ 等个人联系方式。
- `resources/company/<公司名>/Introduction.md` 用作公司背景和岗位上下文，`question.md` 会在选择公司后追加进本场 matcher。

## 技术栈

- Electron main process：窗口、IPC、豆包 ASR WebSocket、题库解析、匹配事件分发。
- Electron preload：调用 `getDisplayMedia` 获取系统音频，并按设置里的麦克风输入调用 `getUserMedia` 获取麦克风音频；两路都转成 `16kHz / 16bit / mono / PCM`，按 200ms 分包发给 main process。
- Electron main process：手动标记通过 `submit_manual_question_segment` IPC 提交系统 ASR 片段，后端只做段内问题整理，不把麦克风内容放进问题正文。
- Electron main process：共享 `InterviewQuestionEngine` 提供自动抽题兜底，系统音频 ASR 结果进入最近约 180 秒的问题上下文窗口，麦克风 ASR 结果只进入最近对话上下文，AI 口述稿生成时传入最近约 2000 字。
- Electron main process：自动问题抽取支持弱追问 pending/吸收、主题级合并、重复压缩和证据约束确认，避免长问题被拆成多条。
- Electron main process：每场会话创建独立归档目录，结束面试时等待 PCM 写入收尾，生成系统/麦克风 WAV、合并 WAV、两路转写、合并转写、问题列表和问题答案快照。
- React/Vite/TypeScript：桌面控制台 UI。
- 火山方舟 Ark Chat API：后台短 JSON 任务用于手动问题整理、自动问题确认、主题合并边界判断和题库候选重排，流式任务用于生成模型口述稿。当前文本任务默认使用 `doubao-seed-2-0-mini-260428`。
- electron-builder：Windows `.exe` / `.msi` 打包。

## 关键文件

```text
package.json
README.md
.github/workflows/build-windows-client.yml
resources/question_bank_embedded.md
resources/company/<公司名>/Introduction.md
resources/company/<公司名>/question.md
resources/icon.ico
electron/main.cjs
electron/preload.cjs
electron/backend/doubaoAsr.cjs
electron/backend/interviewQuestionEngine.cjs
electron/backend/questionMatcher.cjs
electron/backend/arkQuestionEnhancer.cjs
scripts/electron-dev.cjs
scripts/replay-interview-session.mjs
scripts/replay-audio-session.mjs
scripts/replay-interview-utils.mjs
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
node scripts/replay-interview-session.mjs
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
node scripts\replay-interview-session.mjs
npx electron-builder --dir --linux dir
npm ci --dry-run --no-audit --no-fund
```

`npx electron-builder --dir --linux dir` 只验证 Electron 打包配置，不代表 Windows 系统声音已验证。

## 真实端到端待验证

需要在 Windows 本机继续验证：

- Electron `getDisplayMedia` 是否能稳定拿到系统 loopback 音频。
- 设置弹窗里的系统音频输出设备、麦克风输入设备枚举是否符合 Windows 本机实际设备。
- Electron `getUserMedia` 是否能按所选麦克风稳定拿到音频；麦克风识别内容不应进入问题列表和候选匹配。
- 顶部音量是否随会议声音变化。
- PCM 发送豆包 ASR 后是否持续返回 partial/final。
- 开始/暂停/继续/结束面试流程是否符合真实面试节奏。
- 面试前选择公司后，题库健康状态、候选来源徽标和模型口述稿是否正确结合公司资料。
- 小模型后台确认/重排是否在真实音频下能稳定 1 秒级返回。
- 手动标记是否能在真实会议中稳定捕获开始前 10 秒上下文，并在 1 秒左右进入问题列表/候选/AI 答案区域。
- `取消` 和 `撤销手动` 是否能在真实会话中正确更新 UI 与 `question-list.*` / `question-answers.*` 快照。
- `.exe` / `.msi` 安装包运行是否能读取环境变量。

## 使用流程

1. 打开会议软件并让面试官声音从 Windows 系统输出设备播放。
2. 启动客户端：`npm run client`。
3. 顶部 `面试公司` 默认 `无公司`；如果本场有目标公司，先选择对应公司。
4. 按空格或点击 `开始面试`。
5. 设置里可选系统音频输出设备和麦克风输入设备；系统声音捕获仍依赖 Windows 当前会议播放路由。
6. Electron 会请求屏幕/系统音频捕获权限，选择屏幕并允许系统音频；随后会按设置选择的麦克风请求权限作为回答上下文。
7. 顶部系统声音和麦克风音量不是 0%，说明对应音频已采到。
8. 顶部状态胶囊会显示音频、ASR、题库、简历、AI 自检状态；选择公司后题库状态会显示通用题和公司题数量。
9. 推荐在面试官开始问问题时点击 `标记问题` 或按 `M`，问题结束后再次点击或按 `M`。系统会补入开始前 10 秒系统 ASR，并立即整理问题、匹配候选、生成 AI 口述稿。
10. 标记中可点 `取消`；最近一条手动问题可点 `撤销手动`。撤销会从当前 UI 和快照文件中移除，并追加审计事件。
11. 未手动标记时，自动抽题仍会作为兜底结合最近面试官转写和候选人上下文抽取问题；手动标记期间自动 final 不进入历史。
12. 右侧语音识别列同时显示系统实时/系统转写和麦克风实时/麦克风转写。
13. 按空格可在运行和暂停之间切换；点击 `结束面试` 会停止采集并写入本场归档。运行或暂停时不能切换公司。

## 自动归档

每场面试开始后都会创建一个会话目录：

```text
sessions/YYYY-MM-DD_HH-mm-ss_<session-id>/
```

该目录位于项目根目录 `sessions/` 下，主要文件包括：

```text
session-metadata.json
session-summary.json
session-summary.md
system-audio.pcm
system-audio.wav
microphone-audio.pcm
microphone-audio.wav
combined-audio.pcm
combined-audio.wav
system-transcript.txt
system-transcript.json
microphone-transcript.txt
microphone-transcript.json
combined-transcript.txt
combined-transcript.json
question-list.txt
question-list.json
question-answers.md
question-answers.json
question-events.jsonl
```

其中 `system-transcript.*` 是面试官系统声音识别文字，`microphone-transcript.*` 是本人麦克风文字，`combined-transcript.*` 按时间合并两路文字。`question-answers.md` 按问题保存匹配到的题库答案和 AI 口述稿。手动问题会记录 `source: "manual_marker"`、标记起止时间和手动片段；撤销手动问题会追加 `manual_question_undone` 事件。

## 私有回放

真实面试回放基准和报告放在已忽略的目录：

```text
sessions/replay/
```

常用命令：

```powershell
node scripts\replay-interview-session.mjs
node scripts\replay-audio-session.mjs --speed 16
```

转写回放用于快速回归自动问题引擎；音频回放用于端到端验证 ASR + 问题引擎。不要提交 `sessions/replay/` 下的真实转写、音频或报告。

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
