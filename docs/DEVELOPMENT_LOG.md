# Interview Copilot 开发记录

本文档是项目后续开发的固定记录入口。每次有较大功能改动、模型/ASR 调优、真实面试测试、构建失败或关键问题定位，都要在这里追加记录，避免只留在聊天上下文里。

## 记录规则

- 每次开发结束前追加一条记录，按时间倒序写。
- 每条记录至少包含：时间、目标、已完成、验证结果、已知问题、下一步。
- 调试模型或 ASR 时必须记录：输入样例、模型/参数、耗时、返回摘要、失败原因。
- 不记录真实 API Key、完整手机号、邮箱等敏感信息；只记录变量名和是否读取成功。
- 如果改了启动方式、环境变量、端口、脚本或用户操作流程，必须同步更新 `README.md` 和 `docs/LOCAL_CODEX_HANDOFF.md`。
- 如果发现线上或本机真实表现和本文档不一致，以本机实测为准，并立刻追加修正记录。

## 2026-06-02 17:47 +08:00

### 目标

修正左侧 `面试官问题列表` 容易把长问题截断成多条的问题。问题生成要使用最近约 2 分钟系统声音 ASR 上下文，并带上前面几个已确认问题，避免同一问题被拆碎或重复记录。

### 已完成

- `inferQuestionsFromSegments()` 新增 `maxSegments` / `maxChars` 参数，默认仍保持旧的最近 4 段行为，面试主流程显式使用 2 分钟滚动窗口。
- Electron main process 新增系统 ASR 问题上下文窗口：
  - 最近 2 分钟。
  - 最多 80 段。
  - 最多约 2400 字。
- final 稳定转写不再把窗口内推断出的所有问题都发到左侧列表，只取最新一个问题，避免旧问题被重复刷新出来。
- partial 临时问题提高置信度门槛，并把刷新节流从亚秒级放慢到约 1 秒以上，减少半句话抢跑造成的截断问题。
- 后端记录最近已确认问题，方舟问题抽取和问题校准会收到 `previous_questions`，用于识别重复问题和补全最新完整问题。
- 重复问题判断支持“长问题覆盖短截断”：后续更完整的问题可以替换短片段，短片段重复完整问题会被跳过。
- `scripts/test-question-matcher.mjs` 新增长上下文测试，验证扩展窗口能保留旧段落作为问题上下文。

### 验证结果

待本次收尾后执行：

```powershell
node -c electron/main.cjs
node -c electron/backend/questionMatcher.cjs
node -c electron/backend/arkQuestionEnhancer.cjs
npm run test:matcher
npm run build
git diff --check
```

### 已知问题

- 真实效果仍依赖 ASR 分段质量；如果 ASR 把一个长问题拆得很碎，方舟校准会比本地规则更可靠。
- partial 现在更保守，左侧临时问题可能比之前慢一点出现，但 final 问题会更完整。

### 下一步

- 用真实面试音频验证：长问题、追问、笔试类说明是否只生成一条完整问题。

## 2026-06-02 17:31 +08:00

### 目标

按真实面试复盘需求，面试过程中自动保存系统录音、麦克风录音、两路识别文字、合并录音/文字、问题列表，以及每个问题对应的题库答案和 AI 答案。

### 已完成

- 每场面试开始时创建会话归档目录，目录名格式为 `sessions/YYYY-MM-DD_HH-mm-ss_<session-id>/`。
- 后端强制开启自动保存，不再依赖前端手动勾选；设置弹窗显示只读的 `自动保存已开启`。
- 系统声音写入 `system-audio.pcm`，麦克风上下文成功启用时写入 `microphone-audio.pcm`。
- 结束面试时等待音频写入流收尾，并生成：
  - `system-audio.wav`
  - `microphone-audio.wav`
  - `combined-audio.pcm`
  - `combined-audio.wav`
- ASR final 结果持续写入：
  - `system-transcript.txt/json/jsonl`
  - `microphone-transcript.txt/json/jsonl`
  - `combined-transcript.txt/json/jsonl`
- 问题和答案持续写入：
  - `question-list.txt/json`
  - `question-answers.md/json`
  - `question-events.jsonl`
- `question-answers.md` 按问题记录问题文本、ASR 原文、候选题库答案、其他候选和 AI 口述稿。
- `session-metadata.json` 记录开始时间、公司、设备和主要文件；`session-summary.json/md` 在结束面试时记录结束时间、数量统计和主要文件。
- README 和本地交接文档已同步自动归档目录和文件清单。

### 验证结果

已通过：

```powershell
node -c electron/main.cjs
node -c electron/preload.cjs
node -c electron/backend/arkQuestionEnhancer.cjs
npm run test:matcher
npm run build
git diff --check
```

`git diff --check` 仅提示 Windows 工作区 LF/CRLF 转换，没有 whitespace 错误。

### 已知问题

- WAV 和合并音频需要点击 `结束面试` 后生成；如果直接杀掉 Electron 进程，仍可能来不及完成最终封装。
- `combined-audio.wav` 目前是简单 16-bit mono 混音，不做回声消除和说话人分离。
- 麦克风归档文件只在麦克风权限获取成功、上下文 ASR 成功启用后产生。

### 下一步

- Windows Electron 真机跑一场短面试，确认归档目录、两路 WAV、两路转写、合并转写、问题答案文件都按预期生成。

## 2026-06-02 17:22 +08:00

### 目标

按界面标注继续增强音频可见性：顶部同时显示系统声音和麦克风音量，右侧同时显示系统转写和麦克风转写，设置里可以选择系统音频输出设备和麦克风输入设备。

### 已完成

- 顶部音量从单一 `音量` 改为 `系统` 和 `麦克风` 两个紧凑状态块。
- Electron preload 新增 `listMediaDevices()`，通过 `navigator.mediaDevices.enumerateDevices()` 枚举：
  - `audiooutput` 作为系统音频输出设备选项。
  - `audioinput` 作为麦克风输入设备选项。
- 设置弹窗新增：
  - `系统音频输出设备` 下拉。
  - `麦克风输入设备` 下拉。
- 麦克风采集改为按设置里的 `microphoneDeviceId` 调用 `getUserMedia`。
- main process 新增事件：
  - `microphone_audio_status` 用于麦克风音量。
  - `mic_asr_partial` / `mic_asr_final` 用于麦克风实时/稳定转写。
- 右侧 `语音识别` 改为四块：
  - 系统实时。
  - 麦克风实时。
  - 系统转写。
  - 麦克风转写。
- 麦克风转写仍只做上下文，不进入问题列表、不触发 matcher。

### 验证结果

已通过：

```powershell
node -c electron/main.cjs
node -c electron/preload.cjs
npm run build
```

### 已知问题

- 系统音频输出设备选择用于确认和记录会议播放设备；Electron 当前 loopback 捕获仍依赖 Windows 实际播放路由，需要本机实测确认所选设备和会议输出一致。
- 浏览器设备枚举在未授权前可能拿不到完整设备名称，麦克风授权后会刷新一次设备列表。

### 下一步

- Windows Electron 客户端实际开始面试，确认两路音量、两路转写、麦克风设备选择都符合预期。

## 2026-06-02 16:59 +08:00

### 目标

按真实面试使用习惯重排页面，并让 AI 口述稿能利用最近对话上下文回答追问；新增麦克风识别，但麦克风只作为上下文，不参与题目生成。

### 已完成

- 主工作区从四列改为三块：
  - 左侧上下堆叠：上方 `面试官问题列表`，下方 `匹配到的问题`。
  - 中间左右拆分：左侧 `匹配原文答案`，右侧 `AI 输出答案`。
  - 最右侧保留 `语音识别`。
- UI 字号、标题栏、卡片 padding、列表间距和答案行高整体压缩，便于同屏查看更多内容。
- Electron preload 新增麦克风采集：
  - 系统音频继续发送 `audio_chunk`。
  - 麦克风音频发送 `mic_audio_chunk`。
  - 系统音频捕获失败会阻止开始；麦克风授权失败只写日志，不阻断面试。
- Electron main process 新增第二路豆包 ASR：
  - 系统音频 ASR 结果继续进入问题抽取、题库匹配和右侧语音识别。
  - 麦克风 ASR final 结果只进入 `我：...` 最近对话上下文，不发 `asr_final/asr_partial`，不调用 matcher。
- AI 口述稿生成新增 `conversation_context` 字段，截取最近约 2000 字上下文传给方舟。
- 方舟提示词新增约束：上下文只用于理解面试进度和追问承接，`我：` 内容不能当成面试官问题。
- 保存音频时新增可选 `microphone-audio.pcm` 和 `microphone-transcript.jsonl`。
- README 和本地交接文档已同步系统音频/麦克风职责边界、页面布局和使用流程。

### 验证结果

已通过：

```powershell
node -c electron/main.cjs
node -c electron/preload.cjs
node -c electron/backend/arkQuestionEnhancer.cjs
npm run test:matcher
npm run build
```

### 已知问题

- 第二路麦克风 ASR 需要账号侧支持并发连接；如果连接失败，当前策略是继续系统声音面试，只缺少候选人发言上下文。
- 尚未在 Windows 真实会议场景手工确认麦克风授权、双路 ASR 并发和 UI 实际显示密度。

### 下一步

- Windows Electron 客户端端到端验证：系统声音生成问题、麦克风不生成问题、AI 口述稿能承接候选人刚才回答。

## 2026-06-02 16:24 +08:00

### 目标

新增面试前公司选择：选择公司后自动合并公司题库，并把公司介绍和岗位资料注入模型口述稿。

### 已完成

- 顶部新增 `面试公司` 常驻下拉，默认 `无公司`，运行和暂停状态禁止切换。
- Electron 后端扫描 `resources/company/<公司名>/Introduction.md` 和 `question.md`：
  - `Introduction.md` 作为公司上下文注入最终口述稿生成。
  - `question.md` 追加到本场 matcher。
- 公司题库使用 `10000 + 原始编号` 作为内部 id，避免和通用题库编号冲突，并保留原始题号。
- 候选题卡片显示来源徽标：`通用` 或公司名。
- 题库健康状态改为动态文案，例如 `通用 31 题 · 数美 48 题`。
- README 已补充公司资料目录约定和使用流程。

### 验证结果

已通过：

```powershell
npm run test:matcher
npm run build
```

### 已知问题

- 当前只支持单选一个面试公司，不支持多公司题库叠加。
- 公司目录名直接作为展示名和 `companyId`，暂未设计别名或排序配置。

### 下一步

- 在 Windows Electron 客户端手工验证选择 `数美` 后候选来源、健康状态和模型口述稿是否符合真实面试节奏。

## 2026-06-02 15:55 +08:00

### 目标

提交前整理文档、检查敏感信息并完成验证。

### 已完成

- README 补充 `resources/jianli.md` 使用说明：
  - 该文件用于模型口述稿的经历上下文。
  - 可以保留项目经历、技能、岗位方向和业务成果。
  - 不要提交手机号、邮箱、QQ、身份证等个人联系方式。
- `docs/LOCAL_CODEX_HANDOFF.md` 补充同样的简历脱敏约束。
- `resources/jianli.md` 已将联系方式行脱敏为 `联系方式已脱敏`。
- 提交前扫描未发现真实 API Key、手机号或邮箱样例残留。

### 验证结果

已通过：

```powershell
rg -n "<已脱敏的Key片段|手机号|QQ|邮箱样例>" . -g "!node_modules" -g "!dist" -g "!logs"
npm run test:matcher
npm run build
git diff --check
```

说明：

- `rg` 无命中，退出码为 1，表示未找到这些敏感字符串。
- `git diff --check` 仅提示 Windows 换行转换，没有空白错误。

### 已知问题

- `resources/jianli.md` 仍包含候选人姓名、经历和项目细节，这是模型作答所需上下文；如后续要开源或共享仓库，需要再做更彻底的匿名化。

### 下一步

- 提交当前代码与文档改动。

## 2026-06-02 15:50 +08:00

### 目标

调整项目问题识别策略：用户明确要求优先避免漏识别，不需要“只有项目名不生成问题”的保护。

### 已完成

- 取消项目热词必须搭配 `介绍/讲/说/问` 才生成问题的限制。
- 只要 ASR 命中明确的简历项目热词，就可以生成对应的项目介绍问题：
  - 商机推送 / 商机平台 / 商机解析 / 招采 / 采购线索 -> `请介绍一下商机智能推送平台？`
  - 集团 AI 中台 / 云端智能体平台 / 统一接入层 -> `请介绍一下集团AI中台和云端智能体平台？`
  - 合同投标智能评审 / 合同评审 / 投标评审 -> `请介绍一下合同投标智能评审项目？`
  - 运维智能体 / SOP / 经验库 -> `请介绍一下运维智能体项目？`
- 删除“项目热词单独出现不生成问题”的过滤保护。
- 回归测试改为：
  - 单独 `这个商机推送的这个平台` 也必须推断为 `请介绍一下商机智能推送平台？`。
  - 仍然稳定命中题库 #22。

### 验证结果

已通过：

```powershell
node -c electron/backend/questionMatcher.cjs
npm run test:matcher
npm run build
git diff --check
```

### 已知问题

- 当前策略会比之前更积极，项目名相关片段可能更容易进入问题列表。这是本次根据用户要求做出的取舍：宁可多出一条，也优先避免漏掉真实面试问题。

### 下一步

- 继续收集真实 ASR 片段，如果误触发太多，再只针对明显噪声词做局部过滤，不恢复整体严格保护。

## 2026-06-02 15:46 +08:00

### 目标

修复真实 ASR 样例 `这个商机推送的平台，你简单介绍一下呗。` 没有进入左侧问题列表的问题，并根据 `resources/jianli.md` 增加项目、公司、技术和业务热词。

### 已完成

- 从简历补充项目热词：
  - 山东金钟 / 山东金钟科技集团。
  - 集团 AI 中台 / 云端智能体平台 / 统一接入层。
  - 合同投标智能评审 / 合同评审 / 投标评审。
  - 商机智能推送平台 / 商机推送 / 商机解析 / 招采信息 / 招标采购 / 采购线索。
  - 运维智能体 / 运维值守 / SOP / 经验库。
- 从简历补充技术和产品热词：
  - 企业画像、AI 结构化评分、中标概率、推荐度、钉钉通知。
  - 模型分发、模型路由、健康监控、失败切换、用量日志、AI 网关。
  - LangChain、LangGraph、Langfuse、Dify、n8n、MCP。
- 题库 curated hints 增强：
  - #20 合同投标智能评审。
  - #22 商机智能推送平台。
  - #23 集团 AI 中台 / 云端智能体平台。
  - #25 Agent / 工具调用 / 运维智能体相关技术词。
- 问题推断增强：
  - 新增简历项目热词识别。
  - 新增 `项目热词 + 介绍/讲/说/聊` 的分句合并。
  - 新增项目问题规范化：
    - `商机推送的平台，你简单介绍一下呗` -> `请介绍一下商机智能推送平台？`
    - `集团 AI 中台...介绍一下` -> `请介绍一下集团AI中台和云端智能体平台？`
    - `合同投标评审...介绍一下` -> `请介绍一下合同投标智能评审项目？`
    - `运维智能体...介绍一下` -> `请介绍一下运维智能体项目？`
  - 增加保护：只有项目名热词、没有介绍/提问意图时，不单独生成问题。
- 回归测试新增：
  - 完整句 `这个商机推送的平台，你简单介绍一下呗` 必须命中 #22。
  - ASR 分裂成 `这个商机推送的这个平台` + `你简单介绍一下呗。` 也必须推断为 #22。
  - 单独 `这个商机推送的这个平台` 不应生成问题。
  - `集团 AI 中台模型路由权限监控怎么设计` 必须命中 #23。

### 验证结果

已通过：

```powershell
node -c electron/backend/questionMatcher.cjs
npm run test:matcher
npm run build
git diff --check
```

关键测试输出：

```text
这个商机推送的平台，你简单介绍一下呗 -> #22 请介绍一下商机智能推送平台，它的评分规则和效果验证是怎么做的？ score=99
商机智能推送平台评分规则怎么做 -> #22 score=99
集团 AI 中台模型路由权限监控怎么设计 -> #23 score=99
```

### 已知问题

- 目前热词来自简历和题库人工维护；后续如果真实 ASR 出现新的项目别名、错别字或简称，需要继续追加。
- ASR 如果只识别到很短 partial，例如 `嗯，商机推`，仍可能不足以稳定生成问题；但 final 或稍长 partial 出现 `商机推送/商机平台 + 介绍` 后会触发。

### 下一步

- 继续用真实音频收集漏识别样例，优先补项目别名、口语简称、ASR 错字。
- 可考虑从 `resources/jianli.md` 自动抽取项目词作为热词初稿，但当前先用人工 curated 列表保证可控。

## 2026-06-02 15:41 +08:00

### 目标

把模型口述稿从单段文本改成结构化展示，和题库原文答案一样分为 `回答逻辑：` 与 `具体内容：`，其中具体内容按段落展示。

### 已完成

- 方舟口述稿提示词改为强制输出：

```text
回答逻辑：
...

具体内容：
【段落主题】...

【段落主题】...
```

- 具体内容要求 2 到 4 段，每段用 `【段落主题】` 开头，段落之间用空行分隔。
- 前端新增模型口述稿解析：
  - 识别 `回答逻辑：`。
  - 识别 `具体内容：`。
  - 具体内容按段落渲染。
  - 流式返回时可先显示已生成的回答逻辑。
- 模型口述稿样式调整为分块展示：
  - 回答逻辑加粗。
  - 具体内容按段落留间距。
  - 保持在原来的紧凑浅蓝区域内。

### 验证结果

已通过：

```powershell
node -c electron/backend/arkQuestionEnhancer.cjs
npm run build
```

方舟流式口述稿实测：

- 样例问题：`请你做一个简单的自我介绍？`
- 是否包含 `回答逻辑：`：是。
- 是否包含 `具体内容：`：是。
- 完整返回耗时：`2423 ms`
- 流式分片：`214`
- 输出长度：`342` 字

返回摘要：

```text
回答逻辑：基本身份——核心经历——岗位匹配
具体内容：
【基本身份】...

【核心经历】...

【岗位匹配】...
```

### 已知问题

- 流式文本在标题尚未完整返回前，前端会短暂按普通内容处理；标题一旦完整出现，会自动切换为结构化展示。

### 下一步

- 用真实问题验证模型是否稳定保持该格式。
- 如果模型偶尔漏标题，后续可以增加后端格式补全或前端兜底标题。

## 2026-06-02 15:32 +08:00

### 目标

精简问题列表和候选列表视觉样式，并把匹配候选从 Top 3 扩展为 10 条。

### 已完成

- 去掉面试官问题列表选中态的蓝色左边框。
- 去掉匹配候选列表选中态的蓝色左边框。
- 去掉候选卡左侧 `#id` 序号块。
- 本地 `match_candidates` 事件从 3 条扩展为 10 条。
- 方舟问题确认后的候选列表也保留 10 条。
- 方舟 Top3 重排返回后，不再覆盖掉本地其余候选；前面按小模型结果排序，后面补回本地候选到 10 条。
- 定位顶部 `AI` 红色状态原因：
  - 日志显示 Electron 自检当时未读取到 `ARK_API_KEY`。
  - 当前终端和注册表已能读取 `ARK_API_KEY`，方舟 `ping` 调用正常。
  - 增加状态条点击重测，并让 Windows 环境变量读取不缓存空值，减少打开应用后才设置 Key 导致状态一直红的问题。

### 验证结果

已通过：

```powershell
node -c electron/main.cjs
node -c electron/backend/arkQuestionEnhancer.cjs
npm run build
```

方舟 `ping` 实测：

```text
hasKey=true, keyLength=46, model=doubao-seed-2-0-mini-260428, ok=true, elapsedMs=676
```

### 已知问题

- 旧 Electron 窗口如果是在 `ARK_API_KEY` 设置前打开的，状态可能仍显示旧的红色结果；重启客户端或点击顶部状态条重测即可。
- 当前仅构建验证了 UI/类型，没有重新跑真实系统音频端到端。

### 下一步

- 在真实面试音频下确认候选列表显示 10 条后是否仍够紧凑。
- 如果 10 条太长，可以后续增加“展开/收起”或列表高度密度调节，但当前先按用户要求直接显示 10 条。

## 2026-06-02 15:11 +08:00

### 目标

增加顶部启动自检状态、项目本地调试日志，并让每个稳定识别出来的问题都生成方舟小模型口述稿。高分命中题库时，模型应尽量按题库原答案组织；没有可靠题库命中时，再结合简历和相近题库生成。

### 已完成

- 修复 `electron/preload.cjs` 事件白名单：
  - 新增 `model_question_update`。
  - 新增 `ai_match_update`。
  - 新增 `model_answer_update`。
  - 新增 `health_status`。
- 新增启动自检 IPC：
  - `get_health_status`。
  - 检测音频源、ASR Key、题库、简历、方舟小模型。
  - 方舟自检会做一次短 `ping` 调用并记录耗时。
- 顶部 `设置` 左侧新增紧凑状态胶囊：
  - 音频。
  - ASR。
  - 题库。
  - 简历。
  - AI。
- 项目根目录新增固定日志输出：

```text
logs/debug-YYYY-MM-DD.jsonl
logs/session-YYYY-MM-DD.jsonl
logs/model-YYYY-MM-DD.jsonl
```

- `logs/` 已加入 `.gitignore`，避免 ASR 文本和面试问题被提交。
- `resolveApiKey()` 增强为同时读取当前进程环境变量和 Windows 用户/系统环境变量注册表，减少 `setx` 后当前进程读不到变量的问题。
- `electron/backend/arkQuestionEnhancer.cjs` 新增方舟流式 Chat 能力。
- 每个 definite 问题都会触发模型口述稿生成：
  - 本地 Top1 分数高时使用 `answer_guided` 模式，优先复用题库回答逻辑和具体内容。
  - 本地 Top1 分数低或无匹配时使用 `resume_generated` 模式，结合 `resources/jianli.md` 和相近题库生成。
- 前端答案列新增紧凑 `模型口述稿` 区域：
  - 支持流式更新。
  - 保留下方题库原文答案。
  - 没有可靠题库命中时，仍可显示模型口述稿。
- README 和本地交接文档已同步调试日志、自检状态和模型口述稿流程。

### 验证结果

已通过：

```powershell
node -c electron/main.cjs
node -c electron/preload.cjs
node -c electron/backend/arkQuestionEnhancer.cjs
npm run test:matcher
npm run build
npm run test:ark-speed
git diff --check
```

`git diff --check` 仅提示 Windows 换行转换，没有空白错误。

方舟短任务实测：

| 模型 | confirm_question | rerank_ids | infer_question |
| --- | ---: | ---: | ---: |
| `doubao-1-5-lite-32k-250115` | 1230 ms | 768 ms | 1138 ms |
| `doubao-seed-2-0-mini-260428` | 604 ms | 1045 ms | 694 ms |

方舟流式口述稿实测：

- 样例问题：`请你做一个简单的自我介绍？`
- 本地候选：`#1:99,#28:99,#8:37`
- 完整返回耗时：`1900 ms`
- 流式分片：`168`
- 输出长度：`265` 字

### 已知问题

- 模型口述稿现在为了速度，在本地 definite 问题出现后立即开始生成；如果稍后方舟问题确认把问题改得很多，当前实现不会自动取消并重生成同一个 `matchId` 的口述稿。后续如有需要，可加“确认问题差异较大时重启口述稿流”的逻辑。
- 启动自检只检查音频源可用性，不会在打开应用时主动申请屏幕/系统音频权限；真正音频捕获仍在点击 `开始面试` 后触发。
- 日志不记录 API Key，但会记录 ASR 文本、问题和模型摘要，不能提交。

### 下一步

- Windows 本机真实面试声音下验证顶部音量、自检状态、模型口述稿流式刷新是否符合预期。
- 用题库内高分问题验证模型是否确实按原答案组织，而不是自由发挥。
- 用题库外问题验证低匹配时是否能合理结合简历生成回答。
- 如模型答案在高频问题下请求过多，再考虑增加“只对 definite 问题生成、同问题去重、确认问题变化后重启”的更细节策略。

## 2026-06-02 14:53 +08:00

### 目标

放宽“自我介绍”问题识别。真实 ASR 中只要出现“自我介绍”，就应直接推断为题库 #1 的自我介绍问题，避免因为规则过严导致开场问题识别不到。

### 已完成

- 在本地问题推断里把 `自我介绍` / `介绍一下自己` 作为强意图触发词。
- 将命中的自我介绍片段统一归一为：

```text
请你做一个简单的自我介绍？
```

- 更新 matcher 回归测试：
  - `自我介绍` 查询必须命中 #1。
  - `你先自我介绍一下` 必须推断为 #1 对应问题。
  - 即使候选人回答里出现“自我介绍”，也按当前产品策略直接生成自我介绍问题。

### 验证结果

已通过：

```powershell
node -c electron/backend/questionMatcher.cjs
npm run test:matcher
```

测试输出确认：

```text
自我介绍 -> #1 请你做一个简单的自我介绍。
```

### 已知问题

- 这个策略会有意放弃“回答里出现自我介绍时不触发”的严格过滤。当前取舍是优先保证开场自我介绍不漏识别。

### 下一步

- 用真实 ASR 测试“请自我介绍一下”“你先简单介绍一下自己”“那你做个自我介绍吧”等常见说法是否都能稳定落到 #1。

## 2026-06-02 14:49 +08:00

### 目标

把面试辅助工具从“单题监听/锁定/下一题”改成更贴近真实面试的会话模式，并优化 ASR 问题推断、题库匹配、小模型后台确认/重排和界面信息密度。

### 已完成

- UI 改成浅色主题，整体采用白色和浅蓝色搭配。
- 顶部压缩为一行，保留品牌、音量百分比、设置、开始/暂停/继续/结束按钮。
- 设置项移入设置弹窗，包括 Resource ID、采集模式、音频设备、保存开关。
- 主区域改为四栏：
  - 面试官问题列表。
  - 匹配到的问题。
  - 完整原文答案。
  - 语音识别。
- 语音识别列改为上方实时识别、下方倒序完整时间线。
- 面试官问题列表改为历史问题倒序展示，新问题在上方，点击历史问题可切换对应候选和答案。
- 候选列表精简，只显示题号、题目和分数，不再显示搜索框、冗余标签、预览文字。
- 删除前端可见的多余小模型状态：
  - 删除 `推断来源：时间 · 问题`。
  - 删除 `小模型 Top 3` 独立区块。
  - 删除 `小模型建议回答` 和 pending 文案。
- 顶部按钮语义改为：
  - `开始面试`
  - `暂停面试`
  - `继续面试`
  - `结束面试`
- 空格快捷键改为：未开始时开始、进行中暂停、暂停中继续，不再清空当前题。
- 启动脚本 `scripts/electron-dev.cjs` 已支持启动前自动释放 `1420` 端口。
- ASR 参数优化：
  - `result_type: "single"`
  - `end_window_size: 350`
  - `show_utterances: true`
  - `enable_ddc: false`
- 修复 ASR 解析里 `last.start_time` 在 `last` 为 `null` 时可能产生的解析噪音。
- 增加完整识别结果去重/合并逻辑，避免流式 ASR 重复片段刷屏。
- 本地问题推断增强：
  - 支持从最近分句推断面试官问题。
  - 支持倒序保留历史问题。
  - 收紧自我介绍规则，避免把候选人回答误判为问题。
  - 合并团队构成、项目介绍等连续追问片段。
  - 修复 `为什么想从，想面试青岛这边的岗位啊` 被截成 `为什么想从？` 的规则问题。
- 本地题库匹配增强：
  - 保留 token + IDF。
  - 加入 curated hints。
  - 标题命中权重大于答案正文。
  - 加入轻量 token 向量余弦相似度。
  - 题库仍然内存全量打分，不引入向量数据库。
- 新增方舟小模型增强模块 `electron/backend/arkQuestionEnhancer.cjs`：
  - 读取 `ARK_API_KEY` / `VOLCENGINE_ARK_API_KEY` / `DOUBAO_ARK_API_KEY`。
  - 可选读取 `ARK_MODEL`。
  - 可选读取 `ARK_FAST_MODEL`，不配置时使用 `ARK_MODEL`。
  - 支持对 Seed 模型传 `thinking: { type: "disabled" }`，减少实时任务延迟。
- 小模型链路从串行长任务改为后台短任务：
  - partial 只走本地抢跑，不再触发小模型，避免请求堆积。
  - final 问题触发小模型。
  - 问题确认和候选重排并行执行。
  - 候选重排只要求返回 3 个候选 id。
  - 不再实时生成长答案，避免 10 秒以上阻塞。
  - 小模型返回后直接更新同一个候选列表，不显示等待区。
- 新增速度测试脚本 `scripts/test-ark-speed.cjs` 和 npm 命令：
  - `npm run test:ark-speed`

### 实测结果

本机方舟短任务测速，样例问题为“你简单介绍一下这个合同投标评审的这个项目吧？”。

第一次测速：

| 模型 | confirm_question | rerank_ids | infer_question |
| --- | ---: | ---: | ---: |
| `doubao-1-5-lite-32k-250115` | 1499 ms | 691 ms | 959 ms |
| `doubao-seed-2-0-mini-260428` | 462 ms | 433 ms | 645 ms |

第二次测速：

| 模型 | confirm_question | rerank_ids | infer_question |
| --- | ---: | ---: | ---: |
| `doubao-1-5-lite-32k-250115` | 1103 ms | 622 ms | 1559 ms |
| `doubao-seed-2-0-mini-260428` | 822 ms | 595 ms | 1002 ms |

结论：当前环境中，关闭 thinking 后的 `doubao-seed-2-0-mini-260428` 更适合实时后台确认/重排。`doubao-1-5-lite-32k-250115` 可作为对照或备用，但不是当前默认优先选择。

### 验证结果

已通过：

```powershell
node -c electron/backend/arkQuestionEnhancer.cjs
node -c electron/backend/questionMatcher.cjs
node -c electron/backend/doubaoAsr.cjs
node -c electron/main.cjs
npm run test:matcher
npm run test:ark-speed
npm run build
git diff --check
```

说明：

- `git diff --check` 仅提示 Windows 换行转换，没有空白错误。
- `npm run client` 已验证启动脚本会自动杀掉占用 `1420` 的旧进程。

### 当前已知问题

- 启动客户端后点击开始面试时，本机进程仍报：

```text
未检测到豆包 API Key。请在 Windows 用户环境变量中配置 DOUBAO_API_KEY，重启应用后会自动读取。
```

当前代码仍从 `DOUBAO_API_KEY` / `VOLCENGINE_ASR_API_KEY` 读取 ASR Key。后续需要明确是继续使用环境变量，还是按个人本机使用场景做本地硬编码或本地私有配置文件。无论哪种方式，都不能把真实 Key 写入文档或提交历史。

- 方舟 `ARK_API_KEY` 已能被速度测试脚本读取，测试输出只展示 key 是否存在和长度，不打印真实 key。
- 小模型现在不再生成实时建议回答。这样速度更稳定；如果后续还要“小模型根据问题和匹配结果给回答”，建议改成点击某个问题后懒加载，而不是每个 ASR final 自动生成。
- ASR 仍可能受火山分句边界影响出现问题截断，需要继续用真实会议声音测试 `end_window_size`、partial 触发时机和本地合并规则。
- 对题库外问题，例如“你现在是在青岛还是在哪”，本地 Top3 可能仍然不准。这类问题更适合显示为问题历史，但不一定需要强行匹配题库答案。

### 下一步

- 处理 ASR Key 读取策略，解决 `start_session` 的 `DOUBAO_API_KEY` 报错。
- 继续用真实面试音频测试：
  - 自我介绍。
  - 毕业时间。
  - 团队构成和个人角色。
  - 合同/投标智能评审项目。
  - 前端转 AI 产品经理。
- 根据真实日志继续调本地问题合并规则。
- 考虑新增“选中问题后生成小模型建议回答”的懒加载按钮或快捷键，但不要恢复实时 pending 区块。
- 如果要保留调试能力，可以把 `debug.jsonl`、`transcript.jsonl`、`matches.jsonl`、`model-question-updates.jsonl`、`ai-matches.jsonl` 的路径在 UI 设置中显示出来。
