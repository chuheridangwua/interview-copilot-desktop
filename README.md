# Interview Copilot Desktop

Electron + React 桌面端实时面试答案匹配器。当前目标是 Windows 本机真实面试使用；Linux 远程环境适合写代码、调前端、跑匹配测试。

## 核心能力

- 系统输出声音用于识别面试官问题；麦克风可选采集，只作为模型回答的最近对话上下文，不参与题目生成和匹配。
- 通过豆包/火山引擎流式 ASR 识别面试官声音。
- 问题清单已内置到客户端安装包，不依赖 Windows 本地 Markdown 路径。
- 面试前可选择公司，自动合并该公司题库并把公司资料注入模型口述稿。
- 本地毫秒级匹配题库候选，界面显示 Top 3；小模型后台确认问题、重排候选。无论匹配分数高低，最终答案都由 AI 生成，AI 可以直接一模一样输出题库答案，也可以结合当前问法改写。
- 手动标记问题优先：面试运行中点击 `标记问题` 或按 `M` 开始，再次点击或按 `M` 结束；系统会取标记开始前 10 秒到结束之间的系统 ASR 文本，重组成完整问题并立即生成答案。
- 自动抽题保留为实时预览和未手动时的兜底；手动标记期间不会把自动 final 问题写入历史或触发答案。
- 顶部自动自检音频、ASR、题库、简历和方舟小模型状态。
- 普通可缩放桌面窗口展示问题列表、匹配候选、题库原文答案、最终输出答案，以及系统/麦克风两路语音识别时间线。
- 面试会话流程：开始面试 -> 暂停面试 -> 继续面试 -> 结束面试。
- 空格快捷键：未开始时开始、进行中暂停、暂停中继续。

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

可选配置方舟小模型增强：

```powershell
setx ARK_API_KEY "你的ArkKey"
setx ARK_MODEL "doubao-seed-2-0-mini-260428"
```

执行 `setx` 后要重新打开 PowerShell 或重新启动客户端。曾经发到聊天里的 Key 请先去火山/豆包控制台轮换。

`resources/jianli.md` 会作为模型口述稿的个人经历上下文使用。该文件可以保留项目经历、技能、岗位方向和业务成果，但不要提交手机号、邮箱、QQ、身份证等个人联系方式。

公司面试资料放在：

```text
resources/company/<公司名>/Introduction.md
resources/company/<公司名>/question.md
```

`Introduction.md` 会作为公司背景、岗位 JD 和面试重点上下文注入模型口述稿；`question.md` 沿用基础题库格式，会在选择该公司后追加到本场匹配题库。目录名就是公司下拉里的展示名，例如 `resources/company/数美` 会显示为 `数美`。

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
3. 设置 `DOUBAO_API_KEY` 或 `VOLCENGINE_ASR_API_KEY` 环境变量并重新打开客户端。
4. 启动 Interview Copilot。
5. `Resource ID` 默认使用：

```text
volc.seedasr.sauc.duration
```

如果你的账号开通的是并发版，改成：

```text
volc.seedasr.sauc.concurrent
```

6. 顶部 `面试公司` 默认是 `无公司`；如果本场面试有目标公司，先选择对应公司。
7. 点击 `开始面试` 或按空格开始。
8. 设置里可以选择系统音频输出设备和麦克风输入设备；系统声音捕获仍依赖 Windows 当前会议播放路由，请保证会议声音从所选/默认输出播放。
9. Electron 会请求系统声音/屏幕捕获权限。请选择屏幕并允许系统音频；随后会按设置选择的麦克风输入申请权限作为回答上下文。
10. 顶部会分别显示系统声音和麦克风音量。麦克风识别不会进入题目列表，只会给模型口述稿提供“我刚才说过什么”的上下文。
11. 推荐主路径是手动标记：面试官开始问问题时点击 `标记问题` 或按 `M`，问题结束后再次点击或按 `M`。系统会自动补入开始前 10 秒系统 ASR，避免刚点慢时漏掉题干开头。
12. 手动标记只使用面试官系统 ASR；麦克风内容不进入问题正文，只作为 AI 口述稿上下文。
13. 手动标记中可以点 `取消` 丢弃本次区间；最近一条手动问题可以点 `撤销手动` 从当前 UI 和归档快照中移除。
14. 未手动标记时，自动抽题仍会作为兜底生成问题；手动标记期间自动 final 问题不会写入历史，partial 只保留为预览。
15. 左侧问题记录新增后，第二列 `匹配原文答案` 顶部显示 Top 3 题库匹配，下面显示当前选中题库原文答案，右侧显示最终输出答案。
16. 顶部状态胶囊显示音频、ASR、题库、简历、AI 是否可用；悬停可看检测详情。选择公司后题库状态会显示通用题和公司题数量。
17. 无论 Top1 题库匹配分数高低，输出答案都必须由 AI 生成；AI 会收到题库候选、简历、公司资料和最近约 2000 字对话上下文，可以选择一模一样输出题库答案，也可以结合当前问法改写。
18. 最右侧语音识别列同时显示系统实时/系统转写和麦克风实时/麦克风转写。
19. 按空格可暂停/继续面试；点击 `结束面试` 停止采集并保留本场结果。面试运行或暂停时不能切换公司。

## 调试日志

调试日志会固定写入项目根目录：

```text
logs/
```

常见文件：

```text
logs/debug-YYYY-MM-DD.jsonl
logs/session-YYYY-MM-DD.jsonl
logs/model-YYYY-MM-DD.jsonl
```

这些日志用于排查 ASR、问题推断、候选重排、模型口述稿和启动自检。日志不记录 API Key，但可能包含 ASR 文本和面试问题，所以 `logs/` 已加入 `.gitignore`。

## 自动保存

每场面试开始时都会自动创建归档目录，目录名包含实际开始时间和完整面试 ID：

```text
sessions/YYYY-MM-DD_HH-mm-ss_<session-id>/
```

归档目录位于项目根目录的 `sessions/` 下，Windows 本机开发环境默认是：

```text
E:\CLX\project\interview-copilot-desktop\sessions
```

目录内当前会自动保存：

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
transcript.jsonl
system-transcript.jsonl
system-transcript.json
system-transcript.txt
microphone-transcript.jsonl
microphone-transcript.json
microphone-transcript.txt
combined-transcript.jsonl
combined-transcript.json
combined-transcript.txt
matches.jsonl
question-events.jsonl
question-list.json
question-list.txt
question-answers.json
question-answers.md
debug.jsonl
model-question-updates.jsonl
ai-matches.jsonl
model-answers.jsonl
```

`system-audio.pcm` 和 `microphone-audio.pcm` 都是原始 PCM：16 kHz、16-bit、mono。会话结束时会自动封装为 WAV，并生成 `combined-audio.wav`。麦克风文件只在麦克风上下文成功启用时产生。

`system-transcript.*` 保存面试官系统声音识别结果，`microphone-transcript.*` 保存本人麦克风识别结果，`combined-transcript.*` 按时间合并两路文字。`question-list.*` 保存问题列表，`question-answers.md` 会按问题保存对应题库命中答案和最终输出答案，便于复盘。手动标记问题会额外记录 `source: "manual_marker"`、`manualStartedAt`、`manualEndedAt` 和 `manualSegments`；撤销手动问题会追加 `manual_question_undone` 事件，并重写问题列表/答案快照。

## 当前实现说明

- 运行壳已迁移到 Electron。
- React UI 和本地匹配逻辑保留。
- Electron main process 负责豆包 ASR WebSocket、问题库解析、匹配事件分发。
- Electron preload 负责调用 `getDisplayMedia` 获取系统音频，并按设置里的麦克风输入调用 `getUserMedia` 获取麦克风音频；两路都转成 `16kHz / 16bit / mono / PCM`，按 200ms 分包发给 main process。
- 手动标记问题通过 `submit_manual_question_segment` IPC 进入后端，跳过自动边界判断，只让方舟做段内纠错、自包含化和问题重组，然后复用同一套题库匹配、候选重排和答案生成链路。
- Electron main process 使用共享 `InterviewQuestionEngine` 作为自动抽题兜底；自动抽题会结合最近约 180 秒面试官转写和最近约 2000 字候选人上下文，处理弱追问吸收、主题级合并和重复问题压缩。
- 手动标记期间自动问题引擎的 final/update 会被抑制，不进入历史、不触发答案；标记结束后仍会按标记时间窗口屏蔽晚到的自动 final，避免和手动问题重复。
- 麦克风 ASR 结果只写入最近对话上下文，最终口述稿生成时会截取最近约 2000 字传给方舟。
- Electron main process 会自动归档每场面试的系统/麦克风录音、两路转写、整合转写、问题列表，以及每个问题对应的题库答案和 AI 答案。
- Electron main process 会扫描 `resources/company/*`，按当前选择的公司生成会话级 matcher，并把公司 `Introduction.md` 注入最终口述稿生成。
- 方舟小模型后台执行短 JSON 任务，用于手动问题整理、自动 final 问题确认、主题合并边界判断和候选重排；所有文本任务默认使用 `doubao-seed-2-0-mini-260428`。
- 每个 final 问题都会触发方舟生成输出答案；题库候选会作为强参考传入，模型可以一模一样输出题库答案，也可以结合 `resources/jianli.md`、当前公司资料和最近对话上下文改写组织回答。
- 私有回放脚本位于 `scripts/replay-interview-session.mjs` 和 `scripts/replay-audio-session.mjs`；回放基准和报告写入已忽略的 `sessions/replay/`，不提交真实面试内容。
- Windows 真实系统音频采集需要在 Windows 本机继续实测和调优。

## 开发记录

后续开发进度、验证结果、已知问题和下一步统一记录在：

```text
docs/DEVELOPMENT_LOG.md
```

每次较大改动、模型/ASR 调优、真实面试测试或问题定位后都要追加记录。
