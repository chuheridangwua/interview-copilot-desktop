param(
    [string]$ResumePath = "E:\CLX\project\interview-copilot-desktop\resources\jianli.md",
    [string]$JobsCsvPath = "E:\CLX\project\interview-copilot-desktop\JD\腾讯\tencent_jobs_产品经理.csv",
    [string]$OutputCsvPath = "E:\CLX\project\interview-copilot-desktop\JD\腾讯\tencent_jobs_产品经理_top10_简历匹配.csv",
    [int]$TopN = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-AnyPattern {
    param(
        [string]$Text,
        [string[]]$Patterns
    )

    if ([string]::IsNullOrWhiteSpace($Text)) {
        return $false
    }

    foreach ($pattern in $Patterns) {
        if ($Text -match $pattern) {
            return $true
        }
    }

    return $false
}

function Add-UniqueReason {
    param(
        [System.Collections.Generic.List[string]]$Reasons,
        [string]$Reason
    )

    if (-not $Reasons.Contains($Reason)) {
        $Reasons.Add($Reason)
    }
}

function Parse-JobDate {
    param([string]$DateText)

    if ([string]::IsNullOrWhiteSpace($DateText)) {
        return [datetime]::MinValue
    }

    try {
        return [datetime]::ParseExact($DateText.Trim(), "yyyy年MM月dd日", $null)
    }
    catch {
        return [datetime]::MinValue
    }
}

[void](Get-Content -LiteralPath $ResumePath -Raw -Encoding UTF8)
$jobs = Import-Csv -LiteralPath $JobsCsvPath | Where-Object { $_.RecruitPostName -match "产品" }

$positiveSignals = @(
    [pscustomobject]@{
        Name = "AIAgentCore"
        Patterns = @("AI", "AIGC", "大模型", "模型", "Agent", "智能体", "RAG", "Memory", "Tools", "多模态", "ASR", "搜索")
        TitleWeight = 20
        BodyWeight = 12
        Reason = "AI、大模型、Agent 方向与简历主线高度重合"
    },
    [pscustomobject]@{
        Name = "EnterprisePlatform"
        Patterns = @("企业", "平台", "中台", "工作台", "PaaS", "权限", "治理", "组织", "管理", "协作", "知识空间", "编辑器", "企业应用")
        TitleWeight = 18
        BodyWeight = 11
        Reason = "企业 AI 平台、权限治理和协作产品经验可直接迁移"
    },
    [pscustomobject]@{
        Name = "WorkflowKnowledge"
        Patterns = @("办公", "学习", "文档", "知识", "检索", "搜索", "审核", "机器人", "工作流", "会议", "应用体验", "效率")
        TitleWeight = 14
        BodyWeight = 10
        Reason = "文档、知识、工作流和效率场景与既有项目经验接近"
    },
    [pscustomobject]@{
        Name = "ExecutionDesign"
        Patterns = @("规划", "迭代", "架构", "设计", "上线", "交付", "方案", "需求", "体验", "策略", "协同")
        TitleWeight = 10
        BodyWeight = 8
        Reason = "0到1 方案设计、架构规划和跨团队推进要求匹配"
    },
    [pscustomobject]@{
        Name = "DataEvaluation"
        Patterns = @("数据", "评测", "评估", "评分", "效果", "指标", "监控", "日志", "质量", "分析")
        TitleWeight = 10
        BodyWeight = 7
        Reason = "数据评估、效果闭环和平台监控能力可以复用"
    },
    [pscustomobject]@{
        Name = "ResumeScenarioFit"
        Patterns = @("合同", "投标", "商机", "运维", "客服", "知识库", "故障", "审核", "线索", "SOP", "客户")
        TitleWeight = 12
        BodyWeight = 9
        Reason = "岗位场景和简历里的审核、商机、运维类项目更接近"
    }
)

$anchorSignals = @(
    [pscustomobject]@{
        Name = "EnterpriseCollabAnchor"
        Patterns = @("企业微信", "腾讯会议", "WorkBuddy", "知识空间", "编辑器", "企业应用", "智能机器人")
        TitleWeight = 22
        BodyWeight = 14
        Reason = "企业协作和知识工作场景最贴近简历中的 AI 平台与工作流经验"
    },
    [pscustomobject]@{
        Name = "AgentShapeAnchor"
        Patterns = @("QQ-Agent", "数据Agent", "Agent对话", "AI方向", "AI应用", "AI策略", "AI产品经理", "AI原生")
        TitleWeight = 16
        BodyWeight = 10
        Reason = "岗位产品形态与简历中的智能体设计经验直接相关"
    },
    [pscustomobject]@{
        Name = "AgentInfraAnchor"
        Patterns = @("RAG", "Tools", "Memory", "Prompt", "Function Call", "连接器", "技能", "开放体系", "身份体系", "高可用", "安全")
        TitleWeight = 16
        BodyWeight = 12
        Reason = "岗位要求的工具编排、记忆、开放能力与简历中的技术方案能力高度契合"
    },
    [pscustomobject]@{
        Name = "AuditAnchor"
        Patterns = @("审核", "质检", "机审", "人审", "多模态", "评测")
        TitleWeight = 18
        BodyWeight = 12
        Reason = "审核、多模态、评测类场景与合同投标智能评审项目高度接近"
    }
)

$penaltySignals = @(
    [pscustomobject]@{
        Name = "GamePenalty"
        Patterns = @("游戏", "赛事", "电竞", "英雄联盟", "无畏契约", "光子", "WeGame")
        TitleWeight = -16
        BodyWeight = -10
        Reason = "偏游戏内容方向，与当前 B 端 AI 产品履历距离较远"
    },
    [pscustomobject]@{
        Name = "GrowthAdPenalty"
        Patterns = @("增长", "广告", "营销", "流量", "商业化", "会员", "拉新", "续费", "ARPU", "LTV")
        TitleWeight = -14
        BodyWeight = -9
        Reason = "偏增长或商业化运营，与简历主线不完全一致"
    },
    [pscustomobject]@{
        Name = "ContentOpsPenalty"
        Patterns = @("内容生态", "创作者", "社区")
        TitleWeight = -18
        BodyWeight = -8
        Reason = "偏内容或社交运营，与简历中的企业 AI 场景相关性较弱"
    },
    [pscustomobject]@{
        Name = "ConsumerLinePenalty"
        Patterns = @("浏览器", "搜索", "视频", "微视", "输入法", "会员")
        TitleWeight = -24
        BodyWeight = -6
        Reason = "偏消费内容产品线，与当前企业 AI 平台和效率工具经历距离较远"
    }
)

$dedupedJobs = $jobs |
    Sort-Object -Property @{ Expression = {
        ($_.RecruitPostName.Trim() + "|" +
        $_.ProductName.Trim() + "|" +
        $_.BGName.Trim() + "|" +
        $_.LocationName.Trim() + "|" +
        (($_.Responsibility -replace "\s+", "").Trim()))
    } } -Unique

$rankedJobs = foreach ($job in $dedupedJobs) {
    $titleText = @($job.RecruitPostName, $job.ProductName, $job.BGName, $job.LocationName) -join " "
    $bodyText = [string]$job.Responsibility
    $fullText = ($titleText + " " + $bodyText).Trim()
    $score = 0
    $reasons = [System.Collections.Generic.List[string]]::new()
    $penalties = [System.Collections.Generic.List[string]]::new()

    foreach ($signal in $positiveSignals) {
        if (Test-AnyPattern -Text $titleText -Patterns $signal.Patterns) {
            $score += $signal.TitleWeight
            Add-UniqueReason -Reasons $reasons -Reason $signal.Reason
        }

        if (Test-AnyPattern -Text $bodyText -Patterns $signal.Patterns) {
            $score += $signal.BodyWeight
            Add-UniqueReason -Reasons $reasons -Reason $signal.Reason
        }
    }

    foreach ($signal in $anchorSignals) {
        if (Test-AnyPattern -Text $titleText -Patterns $signal.Patterns) {
            $score += $signal.TitleWeight
            Add-UniqueReason -Reasons $reasons -Reason $signal.Reason
        }

        if (Test-AnyPattern -Text $bodyText -Patterns $signal.Patterns) {
            $score += $signal.BodyWeight
            Add-UniqueReason -Reasons $reasons -Reason $signal.Reason
        }
    }

    foreach ($signal in $penaltySignals) {
        if (Test-AnyPattern -Text $titleText -Patterns $signal.Patterns) {
            $score += $signal.TitleWeight
            Add-UniqueReason -Reasons $penalties -Reason $signal.Reason
        }

        if (Test-AnyPattern -Text $bodyText -Patterns $signal.Patterns) {
            $score += $signal.BodyWeight
            Add-UniqueReason -Reasons $penalties -Reason $signal.Reason
        }
    }

    if (
        (Test-AnyPattern -Text $fullText -Patterns @("AI", "AIGC", "大模型", "智能体", "Agent", "RAG")) -and
        (Test-AnyPattern -Text $fullText -Patterns @("企业", "平台", "协作", "知识空间", "编辑器", "会议", "办公", "机器人", "工作台"))
    ) {
        $score += 12
        Add-UniqueReason -Reasons $reasons -Reason "企业协作或平台场景与 AI 能力结合，和现有项目形态最接近"
    }

    if (
        (Test-AnyPattern -Text $fullText -Patterns @("规划", "架构", "设计", "迭代", "方案")) -and
        (Test-AnyPattern -Text $fullText -Patterns @("协同", "上线", "推进", "交付"))
    ) {
        $score += 8
        Add-UniqueReason -Reasons $reasons -Reason "岗位强调从方案到交付的全链路推进，和当前经历匹配"
    }

    if ($reasons.Count -eq 0) {
        $reasons.Add("基础产品能力可迁移，但岗位关键词与简历主线重合度一般")
    }

    $reasonText = ($reasons | Select-Object -First 4) -join "；"
    $penaltyText = ($penalties | Select-Object -First 2) -join "；"

    [pscustomobject]@{
        Rank = 0
        MatchScore = $score
        MatchReason = $reasonText
        Attention = $penaltyText
        RecruitPostName = $job.RecruitPostName
        ProductName = $job.ProductName
        BGName = $job.BGName
        LocationName = $job.LocationName
        LastUpdateTime = $job.LastUpdateTime
        PostURL = $job.PostURL
        Responsibility = $job.Responsibility
        RequireWorkYearsName = $job.RequireWorkYearsName
        MatchRuleNote = "已忽略工作年限，仅按简历能力与岗位内容匹配度排序"
        SortDate = Parse-JobDate -DateText $job.LastUpdateTime
    }
}

$topJobs = $rankedJobs |
    Sort-Object -Property @{ Expression = "MatchScore"; Descending = $true }, @{ Expression = "SortDate"; Descending = $true }, @{ Expression = "RecruitPostName"; Descending = $false } |
    Select-Object -First $TopN

$rank = 1
$topJobsWithRank = foreach ($job in $topJobs) {
    [pscustomobject]@{
        Rank = $rank
        MatchScore = $job.MatchScore
        MatchReason = $job.MatchReason
        Attention = $job.Attention
        RecruitPostName = $job.RecruitPostName
        ProductName = $job.ProductName
        BGName = $job.BGName
        LocationName = $job.LocationName
        LastUpdateTime = $job.LastUpdateTime
        PostURL = $job.PostURL
        Responsibility = $job.Responsibility
        RequireWorkYearsName = $job.RequireWorkYearsName
        MatchRuleNote = $job.MatchRuleNote
    }
    $rank++
}

$topJobsWithRank | Export-Csv -LiteralPath $OutputCsvPath -NoTypeInformation -Encoding UTF8

$topJobsWithRank | Select-Object Rank, MatchScore, RecruitPostName, ProductName, BGName, LocationName, MatchReason, Attention | Format-Table -AutoSize

Write-Host ""
Write-Host "OutputCsvPath: $OutputCsvPath"
