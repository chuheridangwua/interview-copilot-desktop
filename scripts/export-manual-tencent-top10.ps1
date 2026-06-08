param(
    [string]$JobsCsvPath = "E:\CLX\project\interview-copilot-desktop\JD\腾讯\tencent_jobs_产品经理.csv",
    [string]$OutputCsvPath = "E:\CLX\project\interview-copilot-desktop\JD\腾讯\tencent_jobs_产品经理_top10_人工筛选.csv"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$jobs = Import-Csv -LiteralPath $JobsCsvPath

$manualSelections = @(
    [pscustomobject]@{
        Rank = 1
        Index = 95
        ManualMatchReason = "最贴近你现在的经历。岗位核心是企业场景下的 AI 产品策划、身份体系、权限边界和开放能力整合，这和你在集团 AI 统一接入层、权限映射、智能体工作台、跨 SaaS 场景复用上的经历基本同构。"
        PotentialGap = "会议场景不是你当前主场景，但底层的企业权限、开放体系和 Agent 落地方法一致。"
    }
    [pscustomobject]@{
        Rank = 2
        Index = 76
        ManualMatchReason = "这是典型的企业 AI 智能体岗位，强调企业应用服务、数据与 AI 结合、为企业场景提供产品方案，与你做运维智能体、商机推送、企业内部流程 AI 化的履历高度一致。"
        PotentialGap = "会更偏企业微信生态，入职后需要补足 IM/办公协同生态细节。"
    }
    [pscustomobject]@{
        Rank = 3
        Index = 39
        ManualMatchReason = "这个岗位和你的能力结构非常像：企业级智能体规划、技能与连接器体系、评测、安全管控、线上监控、自动化验收、行业模板沉淀。你做过 AI 中台、多场景复用、权限治理和效果闭环，这一条最能打。"
        PotentialGap = "岗位带明显的商业化和大客户交付属性，面试时要准备行业模板、规模化商用和标杆项目打法。"
    }
    [pscustomobject]@{
        Rank = 4
        Index = 8
        ManualMatchReason = "它不是单点功能岗，而是面向销售、运营、客服等流程的 AI Agent 产品，强调工具调用、系统集成、自动化闭环和效果评估，这和你做企业流程 AI 化、知识库检索、工作流编排的经验非常贴。"
        PotentialGap = "更偏内部经营流程和业务自动化，需要准备销售/客服类场景理解。"
    }
    [pscustomobject]@{
        Rank = 5
        Index = 23
        ManualMatchReason = "虽然场景从合同/投标审核换成内容审核，但产品方法几乎一致：机审/人审协同、多模态、Agent、质检指标、平台化复用。你现有的合同和标书审核项目是非常直接的迁移资产。"
        PotentialGap = "需要把你的审核经验从文档审查翻译成内容治理与审核链路语言。"
    }
    [pscustomobject]@{
        Rank = 6
        Index = 66
        ManualMatchReason = "这个岗位要求你定义人-Agent 协作范式、设计工作流、做 Prompt 和 Function Call 编排、建设评测集，同时和工程一起打磨编辑体验。你的 Agent 设计理解、技术背景和 0 到 1 能力是明显加分项。"
        PotentialGap = "你没有明显的协作编辑器或富文本产品背景，面试时要把优势放在 Agent 协作机制和复杂工作流设计上。"
    }
    [pscustomobject]@{
        Rank = 7
        Index = 71
        ManualMatchReason = "这个岗位更偏 AI Agent 策略与效果提升，要求基于场景定义评估标准并推动迭代。你做过多个 AI 场景落地，也强调效果评估和闭环，属于方法论高度匹配。"
        PotentialGap = "场景在会议，用户心智和高频交互节奏与你当前项目不同。"
    }
    [pscustomobject]@{
        Rank = 8
        Index = 112
        ManualMatchReason = "这是少数真正 ToB 且和你的文档审核项目强相关的岗位。OCR 与大模型应用、客户痛点转方案、面向决策层讲价值、规模化复制，这些都能直接借你合同/投标审核和央国企场景经验来讲。"
        PotentialGap = "岗位更强调解决方案和商业落地，base 在厦门，且会更看重客户沟通和行业方案表达。"
    }
    [pscustomobject]@{
        Rank = 9
        Index = 34
        ManualMatchReason = "它比企业微信机器人岗更基础一些，但同样覆盖 AI 功能、基础管理体验和企业协同场景。你做过权限、组织、工作台和多业务集成，这些会比纯消费类 AI 岗更对口。"
        PotentialGap = "AI 深度可能不如机器人岗，更多是基础产品和主框架层面的能力要求。"
    }
    [pscustomobject]@{
        Rank = 10
        Index = 72
        ManualMatchReason = "这条偏技术策略，但和你的知识结构非常对口：Agent 架构、工具调用、多 Agent 协作、任务拆解、记忆与状态管理、badcase 优化。你简历里写到的 MCP/Skill、长短期记忆、人机协同在这里都能展开。"
        PotentialGap = "岗位偏 Agent 中台和技术策略，面试里会更追问架构细节、评测方法和前沿进展。"
    }
)

$exportRows = foreach ($selection in $manualSelections) {
    $job = $jobs[$selection.Index - 1]

    [pscustomobject]@{
        Rank = $selection.Rank
        SelectionMethod = "完整通读全部岗位后人工筛选"
        SourceRowIndex = $selection.Index
        RecruitPostName = $job.RecruitPostName
        ProductName = $job.ProductName
        BGName = $job.BGName
        LocationName = $job.LocationName
        LastUpdateTime = $job.LastUpdateTime
        PostURL = $job.PostURL
        RequireWorkYearsName = $job.RequireWorkYearsName
        ManualMatchReason = $selection.ManualMatchReason
        PotentialGap = $selection.PotentialGap
        Responsibility = $job.Responsibility
    }
}

$exportRows | Sort-Object Rank | Export-Csv -LiteralPath $OutputCsvPath -NoTypeInformation -Encoding UTF8
$exportRows | Sort-Object Rank | Format-Table Rank, SourceRowIndex, RecruitPostName, ProductName, LocationName -AutoSize
Write-Host ""
Write-Host "OutputCsvPath: $OutputCsvPath"
