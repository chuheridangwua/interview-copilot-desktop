# Interview Copilot Desktop

Electron + React 桌面端实时面试答案匹配器。当前目标是 Windows 本机真实面试使用；Linux 远程环境适合写代码、调前端、跑匹配测试。

## 核心能力

- 系统输出声音用于识别面试官问题；麦克风可选采集，只作为模型回答的最近对话上下文，不参与题目生成和匹配。
- 通过豆包/火山引擎流式 ASR 识别面试官声音。
- 问题清单已内置到客户端安装包，不依赖 Windows 本地 Markdown 路径。
- 面试前可选择公司，自动合并该公司题库并把公司资料注入模型口述稿。
- 本地毫秒级匹配 Top 10 候选问题，小模型后台确认问题、重排候选，并为每个稳定问题生成口述稿。
- 顶部自动自检音频、ASR、题库、简历和方舟小模型状态。
- 普通可缩放桌面窗口展示问题列表、匹配候选、题库原文答案、AI 输出答案，以及系统/麦克风两路语音识别时间线。
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
11. 面试官说完一段问题后，左侧新增问题记录，左下显示 Top 10 匹配，中间显示题库原文答案和 AI 输出答案。
12. 顶部状态胶囊显示音频、ASR、题库、简历、AI 是否可用；悬停可看检测详情。选择公司后题库状态会显示通用题和公司题数量。
13. AI 输出答案会额外携带最近约 2000 字对话上下文，便于回答追问；有高分题库命中时优先按题库原答案组织，没有可靠命中时结合简历、公司资料和上下文生成。
14. 最右侧语音识别列同时显示系统实时/系统转写和麦克风实时/麦克风转写。
15. 按空格可暂停/继续面试；点击 `结束面试` 停止采集并保留本场结果。面试运行或暂停时不能切换公司。

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

## 可选保存

默认不保存音频。

手动开启保存后，会写入 Electron 用户数据目录下的会话目录：

```text
sessions/<session-id>/system-audio.pcm
sessions/<session-id>/microphone-audio.pcm
sessions/<session-id>/transcript.jsonl
sessions/<session-id>/microphone-transcript.jsonl
sessions/<session-id>/matches.jsonl
sessions/<session-id>/debug.jsonl
sessions/<session-id>/model-question-updates.jsonl
sessions/<session-id>/ai-matches.jsonl
```

`system-audio.pcm` 和 `microphone-audio.pcm` 都是原始 PCM：16 kHz、16-bit、mono。麦克风文件只在麦克风上下文成功启用时产生。

## 当前实现说明

- 运行壳已迁移到 Electron。
- React UI 和本地匹配逻辑保留。
- Electron main process 负责豆包 ASR WebSocket、问题库解析、匹配事件分发。
- Electron preload 负责调用 `getDisplayMedia` 获取系统音频，并按设置里的麦克风输入调用 `getUserMedia` 获取麦克风音频；两路都转成 `16kHz / 16bit / mono / PCM`，按 200ms 分包发给 main process。
- Electron main process 使用系统音频 ASR 结果做问题抽取和题库匹配；麦克风 ASR 结果只写入最近对话上下文，最终口述稿生成时截取最近约 2000 字传给方舟。
- Electron main process 会扫描 `resources/company/*`，按当前选择的公司生成会话级 matcher，并把公司 `Introduction.md` 注入最终口述稿生成。
- 方舟小模型后台执行短 JSON 任务，用于 final 问题确认和候选重排；前排优先使用小模型 Top 3，后面保留本地 Top 10 候选。
- 每个 final 问题都会触发方舟流式口述稿生成：高分匹配优先复用题库原答案，低分或无匹配时结合 `resources/jianli.md`、当前公司资料和最近对话上下文组织回答。
- Windows 真实系统音频采集需要在 Windows 本机继续实测和调优。

## 开发记录

后续开发进度、验证结果、已知问题和下一步统一记录在：

```text
docs/DEVELOPMENT_LOG.md
```

每次较大改动、模型/ASR 调优、真实面试测试或问题定位后都要追加记录。
