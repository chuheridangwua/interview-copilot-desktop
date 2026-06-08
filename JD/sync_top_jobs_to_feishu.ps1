[CmdletBinding()]
param(
    [string]$BaseToken = "IF3UbUejZaSTDTsE5IkckdPFn4c",
    [string]$TableId = "tblVEj5n5JATZhY0",
    [string]$TencentCsv = "E:\CLX\project\interview-copilot-desktop\JD\腾讯\tencent_jobs_产品经理_top10_人工筛选_新流程.csv",
    [string]$ByteDanceCsv = "E:\CLX\project\interview-copilot-desktop\JD\字节\bytedance_jobs_AI产品经理_top10_人工筛选.csv",
    [string]$TempDir = ".\JD\.tmp_feishu_sync",
    [string]$SummaryPath = "E:\CLX\project\interview-copilot-desktop\JD\feishu_sync_summary.json",
    [string]$DefaultStatus = "未投递",
    [switch]$DryRun,
    [int]$MaxActions = 0,
    [switch]$KeepTemp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Normalize-Link {
    param([AllowNull()][string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return ""
    }

    $trimmed = $Value.Trim()
    if ($trimmed -match '\((https?://[^)]+)\)\s*$') {
        return $Matches[1].Trim()
    }

    return $trimmed
}

function Normalize-Text {
    param([AllowNull()][string]$Value)

    if ($null -eq $Value) {
        return ""
    }

    return ($Value -replace "`r`n", "`n" -replace "`r", "`n").Trim()
}

function Convert-DateText {
    param([AllowNull()][string]$Value)

    $text = Normalize-Text $Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return ""
    }

    $formats = @(
        "yyyy-MM-dd",
        "yyyy/M/d",
        "yyyy/MM/dd",
        "yyyy-M-d",
        "yyyy年MM月dd日",
        "yyyy年M月d日"
    )

    foreach ($format in $formats) {
        try {
            $dt = [datetime]::ParseExact($text, $format, [System.Globalization.CultureInfo]::InvariantCulture)
            return $dt.ToString("yyyy年MM月dd日")
        }
        catch {
        }
    }

    try {
        return ([datetime]::Parse($text)).ToString("yyyy年MM月dd日")
    }
    catch {
        return $text
    }
}

function Build-JdContent {
    param(
        [AllowNull()][string]$Responsibility,
        [AllowNull()][string]$Requirement
    )

    $parts = @()
    $resp = Normalize-Text $Responsibility
    $req = Normalize-Text $Requirement

    if ($resp) {
        $parts += $resp
    }
    if ($req) {
        $parts += "任职要求：$req"
    }

    return ($parts -join "`n`n")
}

function Build-MatchReason {
    param(
        [AllowNull()][string]$ManualMatchReason,
        [AllowNull()][string]$PotentialGap
    )

    $reason = Normalize-Text $ManualMatchReason
    $gap = Normalize-Text $PotentialGap

    if ($reason -and $gap) {
        return "$reason`n`n潜在短板：$gap"
    }
    if ($reason) {
        return $reason
    }
    return $gap
}

function Get-Key {
    param(
        [string]$Company,
        [string]$RoleName,
        [string]$Link
    )

    return ("{0}|{1}|{2}" -f (Normalize-Text $Company), (Normalize-Text $RoleName), (Normalize-Link $Link))
}

function Write-JsonFile {
    param(
        [string]$RelativePath,
        [object]$Value
    )

    $absPath = Join-Path (Get-Location) $RelativePath
    $dir = Split-Path -Parent $absPath
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }

    $json = $Value | ConvertTo-Json -Depth 20 -Compress
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($absPath, $json, $utf8NoBom)
    return $RelativePath
}

function Invoke-LarkJson {
    param(
        [string[]]$CliArgs,
        [string]$Description
    )

    $oldErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $output = & lark-cli @CliArgs 2>&1 | ForEach-Object { $_.ToString() }
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $oldErrorActionPreference
    }

    $text = ($output | Out-String).Trim()
    $jsonStart = $text.IndexOf("{")
    if ($jsonStart -gt 0) {
        $text = $text.Substring($jsonStart).Trim()
    }

    if ($exitCode -ne 0) {
        throw "$Description failed.`n$text"
    }

    try {
        return $text | ConvertFrom-Json
    }
    catch {
        throw "$Description returned non-JSON output.`n$text"
    }
}

function Import-TopJobsCsv {
    param(
        [string]$Path,
        [string]$CompanyName
    )

    $rows = Import-Csv -LiteralPath $Path
    $items = New-Object System.Collections.Generic.List[object]

    foreach ($row in $rows) {
        $link = Normalize-Link $row.PostURL
        $jobName = Normalize-Text $row.RecruitPostName
        $item = [ordered]@{
            公司     = $CompanyName
            地点     = Normalize-Text $row.LocationName
            岗位名称 = $jobName
            事业部名称 = Normalize-Text $row.BusinessLine
            链接     = $link
            发布日期 = Convert-DateText $row.LastUpdateTime
            JD内容   = Build-JdContent -Responsibility $row.Responsibility -Requirement $row.Requirement
            匹配原因 = Build-MatchReason -ManualMatchReason $row.ManualMatchReason -PotentialGap $row.PotentialGap
            状态     = $DefaultStatus
            来源文件 = $Path
            来源序号 = Normalize-Text $row.SourceRowIndex
            排名     = Normalize-Text $row.Rank
            去重键   = Get-Key -Company $CompanyName -RoleName $jobName -Link $link
        }
        $items.Add([pscustomobject]$item)
    }

    return $items
}

function Get-CurrentRecords {
    param(
        [string]$BaseTokenValue,
        [string]$TableIdValue
    )

    $cliArgs = @(
        "base", "+record-list",
        "--base-token", $BaseTokenValue,
        "--table-id", $TableIdValue,
        "--field-id", "公司",
        "--field-id", "岗位名称",
        "--field-id", "链接",
        "--field-id", "状态",
        "--field-id", "发布日期",
        "--limit", "500",
        "--format", "json",
        "--as", "user"
    )

    $result = Invoke-LarkJson -CliArgs $cliArgs -Description "record-list"
    $items = New-Object System.Collections.Generic.List[object]
    $rows = $result.data.data
    $recordIds = $result.data.record_id_list

    for ($i = 0; $i -lt $recordIds.Count; $i++) {
        $row = $rows[$i]
        $statusValue = ""
        if ($row[3] -is [System.Array]) {
            $statusValue = [string]$row[3][0]
        }
        else {
            $statusValue = [string]$row[3]
        }

        $items.Add([pscustomobject]@{
            RecordId = $recordIds[$i]
            公司 = Normalize-Text $row[0]
            岗位名称 = Normalize-Text $row[1]
            链接 = Normalize-Link $row[2]
            状态 = Normalize-Text $statusValue
            发布日期 = Normalize-Text $row[4]
            去重键 = Get-Key -Company $row[0] -RoleName $row[1] -Link $row[2]
        })
    }

    return $items
}

function New-FieldPayload {
    param(
        [psobject]$Job,
        [bool]$IncludeStatus
    )

    $payload = [ordered]@{
        公司 = $Job.公司
        地点 = $Job.地点
        岗位名称 = $Job.岗位名称
        事业部名称 = $Job.事业部名称
        链接 = $Job.链接
        发布日期 = $Job.发布日期
        JD内容 = $Job.JD内容
        匹配原因 = $Job.匹配原因
    }

    if ($IncludeStatus) {
        $payload.状态 = $Job.状态
    }

    return $payload
}

function Invoke-Upsert {
    param(
        [string]$BaseTokenValue,
        [string]$TableIdValue,
        [psobject]$Action,
        [int]$Index
    )

    $fileName = if ($Action.Action -eq "update") {
        "update-{0:D2}-{1}.json" -f $Index, $Action.RecordId
    }
    else {
        "create-{0:D2}-{1}.json" -f $Index, $Action.Job.公司
    }

    $relativeJson = Join-Path $TempDir $fileName
    $relativeJson = $relativeJson -replace "/", "\"
    $jsonPath = Write-JsonFile -RelativePath $relativeJson -Value $Action.Payload

    $cliArgs = @(
        "base", "+record-upsert",
        "--base-token", $BaseTokenValue,
        "--table-id", $TableIdValue,
        "--json", "@$jsonPath",
        "--format", "json",
        "--as", "user"
    )

    if ($Action.Action -eq "update") {
        $cliArgs += @("--record-id", $Action.RecordId)
    }
    if ($DryRun) {
        $cliArgs += "--dry-run"
    }

    $description = "{0} {1}" -f $Action.Action, $Action.Job.岗位名称
    $result = Invoke-LarkJson -CliArgs $cliArgs -Description $description
    Start-Sleep -Milliseconds 200
    return $result
}

$desired = New-Object System.Collections.Generic.List[object]
$desired.AddRange((Import-TopJobsCsv -Path $TencentCsv -CompanyName "腾讯"))
$desired.AddRange((Import-TopJobsCsv -Path $ByteDanceCsv -CompanyName "字节跳动"))

$existing = Get-CurrentRecords -BaseTokenValue $BaseToken -TableIdValue $TableId
$existingMap = @{}
foreach ($item in $existing) {
    $existingMap[$item.去重键] = $item
}

$actions = New-Object System.Collections.Generic.List[object]
foreach ($job in $desired) {
    $key = $job.去重键
    if ($existingMap.ContainsKey($key)) {
        $current = $existingMap[$key]
        $actions.Add([pscustomobject]@{
            Action = "update"
            RecordId = $current.RecordId
            ExistingStatus = $current.状态
            Job = $job
            Payload = New-FieldPayload -Job $job -IncludeStatus:$false
        })
    }
    else {
        $actions.Add([pscustomobject]@{
            Action = "create"
            RecordId = ""
            ExistingStatus = ""
            Job = $job
            Payload = New-FieldPayload -Job $job -IncludeStatus:$true
        })
    }
}

if ($MaxActions -gt 0) {
    $subset = $actions | Select-Object -First $MaxActions
    $trimmedActions = New-Object System.Collections.Generic.List[object]
    $trimmedActions.AddRange($subset)
    $actions = $trimmedActions
}

$summary = [ordered]@{
    generated_at = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    dry_run = [bool]$DryRun
    base_token = $BaseToken
    table_id = $TableId
    existing_count = $existing.Count
    desired_count = $desired.Count
    action_count = $actions.Count
    update_count = @($actions | Where-Object Action -eq "update").Count
    create_count = @($actions | Where-Object Action -eq "create").Count
    actions = @(
        $actions | ForEach-Object {
            [ordered]@{
                action = $_.Action
                record_id = $_.RecordId
                company = $_.Job.公司
                role_name = $_.Job.岗位名称
                link = $_.Job.链接
                existing_status = $_.ExistingStatus
                source_file = $_.Job.来源文件
                source_row = $_.Job.来源序号
                rank = $_.Job.排名
            }
        }
    )
}

$results = New-Object System.Collections.Generic.List[object]
for ($i = 0; $i -lt $actions.Count; $i++) {
    $action = $actions[$i]
    $result = Invoke-Upsert -BaseTokenValue $BaseToken -TableIdValue $TableId -Action $action -Index ($i + 1)
    $okValue = $true
    $identityValue = ""
    if ($null -ne $result -and $null -ne $result.PSObject.Properties["ok"]) {
        $okValue = [bool]$result.ok
    }
    if ($null -ne $result -and $null -ne $result.PSObject.Properties["identity"]) {
        $identityValue = [string]$result.identity
    }
    $results.Add([pscustomobject]@{
        action = $action.Action
        company = $action.Job.公司
        role_name = $action.Job.岗位名称
        record_id = $action.RecordId
        ok = $okValue
        identity = $identityValue
    })
}

$summary.results = $results
$summary.result_count = $results.Count

$summaryDir = Split-Path -Parent $SummaryPath
if (-not (Test-Path -LiteralPath $summaryDir)) {
    New-Item -ItemType Directory -Path $summaryDir -Force | Out-Null
}
$summary | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $SummaryPath -Encoding UTF8

if ((-not $KeepTemp) -and (Test-Path -LiteralPath $TempDir)) {
    Remove-Item -LiteralPath $TempDir -Recurse -Force
}

$summary | ConvertTo-Json -Depth 20
