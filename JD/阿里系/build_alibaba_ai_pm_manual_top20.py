from __future__ import annotations

import csv
import json
import re
from collections import defaultdict
from datetime import date
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SCORED_CSV = BASE_DIR / "本科可投_产品经理" / "alibaba_family_jobs_产品经理_all_评分结果.csv"
SUMMARY_JSON = BASE_DIR / "本科可投_产品经理" / "alibaba_family_jobs_产品经理_all_评分摘要.json"
OUT_CSV = BASE_DIR / "本科可投_产品经理" / "alibaba_family_jobs_产品经理_top20_人工重排.csv"
OUT_MD = BASE_DIR / "本科可投_产品经理" / "alibaba_family_jobs_产品经理_top20_人工重排.md"


SHORTLIST = [
    {
        "title": "钉钉-AI产品经理-开放平台",
        "priority_group": "主攻",
        "why_selected": "AI + ToB + 开放平台三点同时命中，且明确要求 2 年以上 AI/大模型产品经验，最能复用你的 AI 中台、Agent 工作流、平台治理叙事。",
        "main_gap": "缺少开放生态直接经历，需要把 MCP/Skill/权限治理/模型接入讲成平台方法论。",
        "interview_focus": "主讲 AI 中台统一接入层、Agent 编排、权限边界、效果评估与产品工程能力。",
    },
    {
        "title": "阿里云智能-无影产品经理-杭州",
        "priority_group": "主攻",
        "why_selected": "仍然是企业级 AI 办公平台方向，强调大模型理解、平台能力和端到端落地闭环，在不新增淘天岗位的前提下，是最接近你 AI 中台与企业提效经历的替补岗之一。",
        "main_gap": "云电脑、云基础设施和商业化体系经验不足，且岗位默认更偏 3 年以上 B 端/云平台背景。",
        "interview_focus": "重点讲 AI 中台统一接入、成本/稳定性治理、跨团队推进和企业级产品全生命周期能力。",
    },
    {
        "title": "淘宝平台事业部-AI产品经理-阿里资产",
        "priority_group": "主攻",
        "why_selected": "明确接受 1 年以上 AI/数据平台/B 端复杂系统经验，且要求 0-1 落地、SQL/数据分析、LLM/RAG/Agent，跟你的简历最贴。",
        "main_gap": "缺少不良资产和金融科技垂类背景，但这属于业务知识可补，不是能力断层。",
        "interview_focus": "要把商机评分、合同审核、复杂流程重构讲成数据驱动的企业效率产品案例。",
    },
    {
        "title": "淘宝平台事业部-AI产品经理-内控治理",
        "priority_group": "主攻",
        "why_selected": "偏审计、规则、角色协作和复杂流程拆解，与你的合同评审、权限边界、风控可控性设计有天然迁移关系。",
        "main_gap": "没有电商内控经验，需要提前准备互联网治理场景下的指标和流程表达。",
        "interview_focus": "主讲规则抽象、风险分层、人工复核闭环、数据验证与 AI 边界控制。",
    },
    {
        "title": "ATH-AI创新事业部-Qoder 产品经理-企业级能力方向",
        "priority_group": "主攻",
        "why_selected": "2 年以上 + B 端企业软件 + SaaS + 开发工具/AI 能力抽象，这组要求和你的企业 AI 平台、流程提效、复杂协同经验更顺，且比被替换岗位少一层采购垂域包袱。",
        "main_gap": "开发者工具与全球社区英语语境仍是短板，需要把企业级能力抽象讲得更硬。",
        "interview_focus": "主讲企业级能力抽象、工作流设计、交付与客户成功协同，以及技术可行性和业务价值的平衡。",
    },
    {
        "title": "企业智能事业部-高级产品经理-HR域",
        "priority_group": "主攻",
        "why_selected": "至少 1 年 AI 或企业数字化系统经验即可，HR 场景虽然垂直，但企业协同、权限、流程和 AI 提效逻辑与你过去项目相通。",
        "main_gap": "缺 HR 业务沉淀，且高级 title 有一定压力。",
        "interview_focus": "提前准备招聘/SSC/组织效率类场景，把你做过的人机协同和审核闭环迁移过去。",
    },
    {
        "title": "天猫事业部-运营AI产品经理-杭州",
        "priority_group": "主攻",
        "why_selected": "岗位明确写 1-3 年 AI 产品经验，强调能直接搭 Agent、skill、demo，这与你的产品工程和 MVP 落地能力非常对口。",
        "main_gap": "缺电商运营经验，需要说明你如何快速理解业务并找到 AI 提效节点。",
        "interview_focus": "展示你能亲手搭 Demo、快速验证、用数据和 badcase 迭代 AI 效果。",
    },
    {
        "title": "ATH-AI创新事业部-Qoder 产品经理-AI 创新方向",
        "priority_group": "主攻",
        "why_selected": "2 年以上产品经验门槛相对合理，且聚焦 AI Agent、SaaS、开发者工具和行业产品化，符合你偏技术型 AI 产品经理定位。",
        "main_gap": "开发者工具与英语资料阅读是弱项，需要补 AI Coding / Agent 产品视角。",
        "interview_focus": "强化你对 AI Agent 产品范式、工程落地、行业抽象和产品创新的理解。",
    },
    {
        "title": "淘宝秒杀-AI AGENT产品经理-杭州",
        "priority_group": "重点跟进",
        "why_selected": "只要求 1 年以上互联网产品经验，有 AI 落地经验优先，是阿里系里少数对你当前年限友好的 Agent 岗。",
        "main_gap": "电商运营场景和 SQL 分析要补，最好准备一个能量化的实验或指标故事。",
        "interview_focus": "突出 AI Agent 在复杂运营链路中的任务拆解、提示词设计、效果评估和数据闭环。",
    },
    {
        "title": "企业智能事业部-AI产品经理-AI Agent",
        "priority_group": "重点跟进",
        "why_selected": "虽然偏开发者生态和技能市场，但平台治理、供需匹配、后台设计这些能力和你做过的 AI 平台并不远。",
        "main_gap": "缺开放平台/开发者生态直接经验，面试时要防止被问住插件分发、生态治理和开发者运营。",
        "interview_focus": "把 AI 中台能力包装成平台产品思维，准备开发者体验与安全治理的平衡问题。",
    },
    {
        "title": "阿里云智能-AI Agent 产品经理-秒悟-杭州",
        "priority_group": "重点跟进",
        "why_selected": "没有写死 3 年门槛，且同时覆盖 AI Agent、AI Coding、协同办公和模型评估，比千问用户型 Agent 更贴近你偏企业效率与产品工程的 AI 产品经理主线。",
        "main_gap": "AI Coding 与开发者工作流实践需要讲得更具体，面试里最好能拿出你亲手做过的 AI 原型、工作流或 Vibe Coding 例子。",
        "interview_focus": "重点讲 AI 原型搭建、模型选型与评测、用户体验优化、数据驱动迭代，以及如何把企业级 AI 经验迁移到通用办公产品。",
    },
    {
        "title": "阿里国际站-AI 产品经理 — Agentic Platform-Accio Work",
        "priority_group": "重点跟进",
        "why_selected": "岗位 AI Native 味道最重，强调 hands-on、Agentic、0-1、Owner，这些和你的产品工程能力及 Agent 落地经验高度相关。",
        "main_gap": "国际化、电商和英语环境是明显门槛，属于高价值但偏冲刺的机会。",
        "interview_focus": "把自己讲成能亲手做原型、快速闭环、对 Agent 产品趋势有独立判断的人。",
    },
    {
        "title": "阿里国际站-产品经理（CRM）-数字营销",
        "priority_group": "重点跟进",
        "why_selected": "你做过 CRM、线索跟进和商机推送，CRM 与销售协同链路比跨境商详、纯营销场景更容易讲出可迁移的产品故事，也是非淘天岗位里更务实的补位项。",
        "main_gap": "国际站与数字营销语境不熟，且互联网年限要求略卡边，需要提前准备销售效率和客户生命周期表达。",
        "interview_focus": "把商机推送、CRM 协同、线索评分与流程闭环讲成销售数字化与 AI 提效故事。",
    },
    {
        "title": "智能算法产品事业部-运营平台产品经理-杭州",
        "priority_group": "重点跟进",
        "why_selected": "2 年及以上 B 端或工具类经验，偏平台和提效工具，匹配你的工具化、平台化、流程提效叙事。",
        "main_gap": "业务更偏电商运营平台，不是纯 AI 平台，需要准备业务理解问题。",
        "interview_focus": "强调需求抽象、PRD/原型、跨团队推进，以及 AI 提效工具建设经验。",
    },
    {
        "title": "钉钉-AI听记-产品经理",
        "priority_group": "重点跟进",
        "why_selected": "B 端协同、知识管理、AI 应用落地仍然对口，比智能合同和大客户产品少一层证书门槛，更适合作为钉钉体系内的补位岗。",
        "main_gap": "语音、会议协同与听记场景缺经验，且岗位默认更偏 3 年以上互联网产品背景。",
        "interview_focus": "把运维知识沉淀、企业协同、知识库与多轮交互经验迁移到会议纪要、知识管理和协作提效场景。",
    },
    {
        "title": "高德-AI产品经理（商家成长方向）-信息业务中心",
        "priority_group": "重点跟进",
        "why_selected": "虽然分数不在第一梯队，但它偏 B 端商家成长而非纯消费端，对 AI 场景判断、AB 实验、业务价值量化的要求和你并不冲突。",
        "main_gap": "本地生活商家业务陌生，需要提前补商家经营链路、GMV 和漏斗指标。",
        "interview_focus": "把你过往的效率提升、线索评分、问题发现能力翻译成商家增长与经营提效语言。",
    },
    {
        "title": "通义大模型事业部-多模态大模型产品经理-杭州",
        "priority_group": "冲刺补位",
        "why_selected": "这是更纯的 AI 产品方向，强调模型边界、成本/效果权衡与规模化方法论，能更直接体现你技术型 AI 产品经理的定位。",
        "main_gap": "多模态公共云和规模化商业化经验不足，3 年以上门槛也更高，属于明确冲刺岗。",
        "interview_focus": "准备模型能力边界、效果评估、ROI、复杂客户场景抽象和从单点能力到平台能力复制的方法论。",
    },
    {
        "title": "ATH事业群-AI原生应用产品经理-杭州",
        "priority_group": "冲刺补位",
        "why_selected": "AI 原生应用、RAG、Agent、知识工程这些关键词和你的经历高度匹配，是能力层面的强对口岗位。",
        "main_gap": "明确要求 3 年及以上产品经验，且偏阿里云企业产品背景，年限是主要风险。",
        "interview_focus": "如果投这个岗位，重点把你做过的企业 AI 落地结果、平台复用和产品工程讲得更成熟。",
    },
    {
        "title": "企业智能事业部-AI产品经理-to B方向",
        "priority_group": "冲刺补位",
        "why_selected": "ToB + 企业 AI 落地强相关，模型给分也很高，业务理解与你的企业项目最接近。",
        "main_gap": "明确写 3 年以上 ToB 产品经验，还带法务场景，这对你当前阶段是明显冲刺项。",
        "interview_focus": "如果面，主打你已经做过的合同/投标审核、法务相关流程理解和问题抽象能力。",
    },
    {
        "title": "悟空事业部-Agent平台产品经理-企业悟空",
        "priority_group": "冲刺补位",
        "why_selected": "Agent 平台、ToB、企业服务方向本身很适合你的履历，模型评分也高。",
        "main_gap": "3 年以上和企业级商业包装能力要求偏高，且对大客户/市场化认知要求更强。",
        "interview_focus": "把自己定位成技术型 AI 产品经理，强调平台搭建、复杂协同和 0-1，而不是纯 SaaS 商业化经验。",
    },
]


OUTSIDE_TOP20_COMPANY_NOTES = {
    "千问": "已纳入评分，但高分岗位大多偏 C 端/用户型 Agent 或要求 3 年以上互联网产品经验，不如 ToB 平台岗适合当前履历。",
    "淘宝闪购": "已纳入评分，但更偏即时零售、商品/经营或本地生活场景，和你的企业 AI 平台经验迁移成本偏高。",
    "盒马": "已纳入评分，但主力岗位偏导购、零售消费场景，需要更强 C 端零售产品经验，不是你的主优势区。",
}


YEAR_PATTERNS = [
    (re.compile(r"[1一]\s*[-~至到]\s*[3三]\s*年"), "1-3年"),
    (re.compile(r"[1一]\s*[-~至到]\s*[5五]\s*年"), "1-5年"),
    (re.compile(r"[5五]\s*年及以上|[5五]年以上|至少[5五]年"), "5+年"),
    (re.compile(r"[4四]\s*年及以上|[4四]年以上|至少[4四]年"), "4+年"),
    (re.compile(r"[3三]\s*年及以上|[3三]年以上|工作[3三]年以上|[3三]年左右"), "3+年"),
    (re.compile(r"[2二两]\s*年及以上|[2二两]年以上|至少[2二两]年"), "2+年"),
    (re.compile(r"[1一]\s*年及以上|[1一]年以上|至少[1一]年"), "1+年"),
]


def load_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def detect_experience_gate(text: str) -> str:
    normalized = (text or "").replace("\u00a0", " ")
    for pattern, label in YEAR_PATTERNS:
        if pattern.search(normalized):
            return label
    return "未写明"


def detect_role_risk(title: str, requirement_text: str) -> str:
    text = f"{title}\n{requirement_text}"
    gate = detect_experience_gate(requirement_text)
    if "资深" in text or gate in {"4+年", "5+年"}:
        return "高"
    if "高级" in text or gate in {"3+年", "1-5年"}:
        return "中高"
    if gate in {"2+年", "1-3年", "1+年"}:
        return "中"
    return "中低"


def markdown_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", "<br>")


def main() -> None:
    rows = load_rows(SCORED_CSV)
    if not rows:
        raise RuntimeError(f"未读取到评分结果: {SCORED_CSV}")

    sorted_rows = sorted(rows, key=lambda row: int(row["total_score"]), reverse=True)
    model_rank_map = {row["title"]: index for index, row in enumerate(sorted_rows, start=1)}
    title_map = {row["title"]: row for row in rows}

    shortlisted_rows: list[dict[str, str]] = []
    missing_titles: list[str] = []
    for manual_rank, item in enumerate(SHORTLIST, start=1):
        row = title_map.get(item["title"])
        if row is None:
            missing_titles.append(item["title"])
            continue

        shortlisted_rows.append(
            {
                "Rank": str(manual_rank),
                "SelectionMethod": "执行日2026-06-09；近3个月过滤+排除5年以上/硕士及以上+豆包评分后人工重排",
                "SourceRowIndex": row["source_row_index"],
                "RecruitPostName": row["title"],
                "BusinessLine": row["business_line"],
                "LocationName": row["location"],
                "LastUpdateTime": row["publish_date"],
                "PostURL": row["post_url"],
                "Responsibility": row["responsibility"],
                "Requirement": row["requirement_text"],
                "ManualMatchReason": item["why_selected"],
                "PotentialGap": item["main_gap"],
                "manual_rank": str(manual_rank),
                "priority_group": item["priority_group"],
                "model_rank": str(model_rank_map[row["title"]]),
                "company": row["company"],
                "title": row["title"],
                "location": row["location"],
                "publish_date": row["publish_date"],
                "total_score": row["total_score"],
                "experience_gate": detect_experience_gate(row["requirement_text"]),
                "role_risk": detect_role_risk(row["title"], row["requirement_text"]),
                "why_selected": item["why_selected"],
                "main_gap": item["main_gap"],
                "interview_focus": item["interview_focus"],
                "business_line": row["business_line"],
                "source_row_index": row["source_row_index"],
                "requirement_text": row["requirement_text"],
                "post_url": row["post_url"],
            }
        )

    if missing_titles:
        missing = "\n".join(missing_titles)
        raise RuntimeError(f"以下岗位未在评分结果中找到，请检查标题是否变化：\n{missing}")

    company_counts = defaultdict(int)
    for row in shortlisted_rows:
        company_counts[row["company"]] += 1

    over_limit = {company: count for company, count in company_counts.items() if count > 5}
    if over_limit:
        detail = ", ".join(f"{company}={count}" for company, count in sorted(over_limit.items()))
        raise RuntimeError(f"人工 Top20 违反单公司最多 5 个岗位约束：{detail}")

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with OUT_CSV.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "manual_rank",
                "priority_group",
                "model_rank",
                "Rank",
                "SelectionMethod",
                "SourceRowIndex",
                "company",
                "title",
                "RecruitPostName",
                "BusinessLine",
                "location",
                "LocationName",
                "publish_date",
                "LastUpdateTime",
                "PostURL",
                "total_score",
                "experience_gate",
                "role_risk",
                "Responsibility",
                "Requirement",
                "ManualMatchReason",
                "PotentialGap",
                "why_selected",
                "main_gap",
                "interview_focus",
                "business_line",
                "source_row_index",
                "requirement_text",
                "post_url",
            ],
        )
        writer.writeheader()
        writer.writerows(shortlisted_rows)

    summary = {}
    if SUMMARY_JSON.exists():
        summary = json.loads(SUMMARY_JSON.read_text(encoding="utf-8"))

    grouped_outside_rows: dict[str, list[dict[str, str]]] = defaultdict(list)
    shortlisted_titles = {row["title"] for row in shortlisted_rows}
    for row in sorted_rows:
        if row["title"] in shortlisted_titles:
            continue
        grouped_outside_rows[row["company"]].append(row)

    top10_rows = shortlisted_rows[:10]
    next10_rows = shortlisted_rows[10:]

    md_lines: list[str] = []
    md_lines.append("# 阿里系 AI 产品经理 Top20 人工重排")
    md_lines.append("")
    md_lines.append(f"- 生成日期：{date.today().isoformat()}")
    md_lines.append(f"- 评分输入：`{SCORED_CSV}`")
    if summary:
        md_lines.append(
            f"- 样本概况：共 {summary.get('source_total', '?')} 个产品经理岗位，过滤后剩余 {summary.get('eligible_total', '?')} 个，本榜单在统一模型评分基础上加入了年限、场景迁移和当前履历可讲性修正。"
        )
    md_lines.append("- 人工重排原则：优先 `AI + ToB + 平台/Agent/工作流`，优先 `1-2年或未写死年限`，压低 `3年以上/高级/资深/强垂直领域/C端增长导向` 岗位。")
    md_lines.append("- 本版额外约束：`淘天不再新增`，且 `单公司最多保留 5 个岗位`。")
    md_lines.append("")
    md_lines.append("## Top10 主攻")
    md_lines.append("")
    md_lines.append("| 人工排名 | 岗位 | 公司 | 模型分 | 年限门槛 | 组别 | 关键原因 |")
    md_lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for row in top10_rows:
        md_lines.append(
            "| "
            + " | ".join(
                [
                    row["manual_rank"],
                    markdown_escape(row["title"]),
                    row["company"],
                    row["total_score"],
                    row["experience_gate"],
                    row["priority_group"],
                    markdown_escape(row["why_selected"]),
                ]
            )
            + " |"
        )

    md_lines.append("")
    md_lines.append("## 11-20 补位与冲刺")
    md_lines.append("")
    md_lines.append("| 人工排名 | 岗位 | 公司 | 模型分 | 年限门槛 | 风险 | 主要短板 |")
    md_lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for row in next10_rows:
        md_lines.append(
            "| "
            + " | ".join(
                [
                    row["manual_rank"],
                    markdown_escape(row["title"]),
                    row["company"],
                    row["total_score"],
                    row["experience_gate"],
                    row["role_risk"],
                    markdown_escape(row["main_gap"]),
                ]
            )
            + " |"
        )

    md_lines.append("")
    md_lines.append("## 站点说明")
    md_lines.append("")
    md_lines.append("- `阿里国际 / 阿里云 / 高德` 已进入本次统一评分，且各自都有进入候选池的岗位；其中 `阿里国际站-AI 产品经理 — Agentic Platform-Accio Work`、`ATH事业群-AI原生应用产品经理-杭州`、`高德-AI产品经理（商家成长方向）` 已保留在人工 Top20。")

    for company, note in OUTSIDE_TOP20_COMPANY_NOTES.items():
        outside_rows = grouped_outside_rows.get(company)
        if not outside_rows:
            continue
        best_row = outside_rows[0]
        md_lines.append(
            f"- `{company}` 已纳入评分但未进人工 Top20：站内最高分岗位为 `{best_row['title']}`（{best_row['total_score']} 分，{detect_experience_gate(best_row['requirement_text'])}），原因：{note}"
        )

    md_lines.append("")
    md_lines.append("## 投递建议")
    md_lines.append("")
    md_lines.append("- 第一批先投 `Top10 主攻`，它们最容易沿用你现有简历和项目叙事。")
    md_lines.append("- `11-20` 里优先补位 `阿里国际 / 高德 / 阿里云`，用于拉开业务面；但 `3年以上` 和强垂直领域岗位要按冲刺岗心态准备。")
    md_lines.append("- 面试统一主线建议保持为：`AI中台/统一接入层 -> 多Agent工作流 -> 企业流程提效 -> 权限/效果/ROI治理 -> 能亲手搭MVP`。")

    OUT_MD.write_text("\n".join(md_lines) + "\n", encoding="utf-8")

    print(f"生成完成：{OUT_CSV}")
    print(f"生成完成：{OUT_MD}")


if __name__ == "__main__":
    main()
