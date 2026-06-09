from __future__ import annotations

import csv
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SOURCE_CSV = BASE_DIR / "meituan_jobs_产品经理_manual_candidates_评分结果.csv"
OUTPUT_CSV = BASE_DIR / "meituan_jobs_产品经理_top10_人工筛选.csv"
SELECTION_METHOD = (
    "执行日2026-06-09；美团产品经理候选人工整合（share-position + social 列表摘要 + 详情页补全）"
    "+近3个月过滤+豆包评分后人工复核"
)


TOP10 = [
    {
        "title": "LongCat大模型 - 大模型评测平台产品经理",
        "rank": 1,
        "source_note": "职位详情已核实",
        "match_reason": (
            "这是美团里与你当前履历最同构的一档平台型 AI 产品岗之一：它不是单点功能 PM，而是做评测平台、实验追踪、数据管理、"
            "结果分析和跨算法/工程协同的人效平台。你已经做过集团 AI 中台、统一接入层、效果监控与多场景复用，且能自己补技术细节，"
            "因此在“平台化抽象 + 技术理解 + 推进落地”上最容易讲出成体系的案例。"
        ),
        "gap": "没有大模型评测平台的直接项目名头，面试里要把“效果评估、反馈闭环、问题归因”讲成可迁移的方法论，而不是只讲业务场景。",
    },
    {
        "title": "LongCat大模型 - Agent 评测产品经理（欢迎算法/工程转型）",
        "rank": 2,
        "source_note": "职位详情已核实",
        "match_reason": (
            "这条和你的 Agent/工作流经验贴合度很高：岗位核心是长程任务评测、数据闭环、Rubrics、专家资源池和框架演进跟踪。"
            "你在合同审核、商机评分、运维智能体里都做过“流程拆解 - Agent 串联 - 结果复核 - 持续优化”的闭环，"
            "只要把业务语言翻译成评测语言，就很容易形成说服力。"
        ),
        "gap": "需要补足 Coding / 数据分析类生产力场景的评测视角，尤其是如何定义任务成功率、过程指标与 badcase 归因。",
    },
    {
        "title": "Agent产品经理",
        "rank": 3,
        "source_note": "仅列表页摘要，投递前建议再开详情页确认",
        "match_reason": (
            "从岗位摘要看，这是非常标准的 Agent 产品规划岗，核心就是规划、设计、路线图和持续优化。你现有优势正好是把真实业务问题拆成"
            "可落地的 Agent 链路，并能兼顾方案、原型、接入、测试与复盘，所以在“会定义产品、也能把产品做出来”这一点上非常占优。"
        ),
        "gap": "目前只拿到了列表摘要，没有看到完整 JD；正式投递前要确认它更偏通用 Agent 平台，还是偏具体业务/搜索/商业分析场景。",
    },
    {
        "title": "AI产品经理（NoCode&CatPaw系列产品）",
        "rank": 4,
        "source_note": "仅列表页摘要，投递前建议再开详情页确认",
        "match_reason": (
            "这条最大的亮点是它明确要求“AI Builder”型 PM，而不是纯文档型产品经理。你会自己上手 Python、Node.js、LangGraph、"
            "Codex/Claude 做 MVP，也能从需求、原型、接入到测试打通，这比传统 PM 更贴近它想要的“会用 AI 直接产出”的人。"
        ),
        "gap": "需要准备你在 NoCode/低代码/AI 工具化工作流上的代表性例子，证明你不是只会调模型，而是真的能用工具直接产出功能和流程。",
    },
    {
        "title": "AI高阶产品经理",
        "rank": 5,
        "source_note": "仅列表页摘要，投递前建议再开详情页确认",
        "match_reason": (
            "这条虽然行业在餐饮 SaaS，但本质仍是 ToB AI 产品商业化：从需求定义、场景挖掘到 Agent 能力落地。你做企业 AI 转型、"
            "统一中台和多业务场景落地的经历，和“找到高价值场景 -> 做 MVP -> 形成复用”这套打法很接近，比纯 C 端增长岗更适合你。"
        ),
        "gap": "缺少餐饮 SaaS 和商家经营场景经验，面试要提前补商家经营链路、门店流程、SaaS 交付和 ROI 叙事。",
    },
    {
        "title": "AI应用产品经理（B端）",
        "rank": 6,
        "source_note": "职位详情已核实",
        "match_reason": (
            "这条是美团平台内偏 BA/商业分析场景的 Agent 评测与优化岗。你做过商机评分、业务结构化、规则/模型联合判断，也能把 AI"
            " 结果通过闭环机制持续优化，因此在“用评测和数据驱动产品迭代”上比普通 PM 更有可讲的实战。"
        ),
        "gap": "岗位更偏商业分析和平台内 B 端使用场景，需要补强你对经营分析、业务分析 Agent、AB 与评估框架的表达。",
    },
    {
        "title": "中台产品经理",
        "rank": 7,
        "source_note": "仅列表页摘要，投递前建议再开详情页确认",
        "match_reason": (
            "如果把 AI 标签拿掉，你最硬的一项仍然是“中台/统一能力平台”经验。你做过 AI 统一接入层、模型路由、权限映射、健康监控和多场景复用，"
            "这和中台产品经理要求的抽象能力、跨业务协同和支撑效率非常接近。"
        ),
        "gap": "在线娱乐场景不是你的背景，需要把你对“中台能力抽象”的理解讲得足够强，避免被追问到垂直业务细节时失分。",
    },
    {
        "title": "AI产品经理（AI Builder方向）",
        "rank": 8,
        "source_note": "仅列表页摘要，投递前建议再开详情页确认",
        "match_reason": (
            "这条和你的“AI产品0到1 + 自己会动手做”的气质很像，尤其适合把你用 AI 改造流程、快速做 MVP、打通原型到上线的能力讲出来。"
            "如果它真的是偏 Builder 角色，你比纯增长或纯营销背景的人更有优势。"
        ),
        "gap": "它明显偏内容营销/广告投放/用户增长，这部分与你的央国企 ToB 业务差异较大，面试里要主动补“用户增长 + 实验 + 内容分发”认知。",
    },
    {
        "title": "产品经理",
        "rank": 9,
        "source_note": "职位详情已核实",
        "match_reason": (
            "这条虽然本质是 C 端商业化增长产品，但它也强调 AI/大模型能力探索、算法协同、数据驱动和承接链路设计。若你想拿美团平台通道，"
            "它是一个可以投的保底位，能让你把“问题拆解、策略设计、与算法协同”这部分能力讲出来。"
        ),
        "gap": "核心短板还是 C 端本地生活增长经验不足，你需要避免把它当主攻岗，只适合作为补位，不适合作为最优先投递目标。",
    },
    {
        "title": "数据产品经理",
        "rank": 10,
        "source_note": "仅列表页摘要，投递前建议再开详情页确认",
        "match_reason": (
            "这条不是最优，但仍比纯线下场景或商家生态更能迁移。你做过商机评分、指标判断、业务结构化与流程提效，如果对方更看重“能把业务问题转成数据产品能力”，"
            "你仍有发挥空间。"
        ),
        "gap": "缺乏强数据产品背景和成熟的数据指标体系建设经验，且充电宝业务与你的主线经历差异较大，只建议放在靠后顺位。",
    },
]


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def main() -> None:
    rows = read_rows(SOURCE_CSV)
    by_title = {row["title"]: row for row in rows}

    output_rows = []
    for item in TOP10:
        source = by_title[item["title"]]
        output_rows.append(
            {
                "Rank": str(item["rank"]),
                "SelectionMethod": SELECTION_METHOD,
                "SourceRowIndex": source["source_row_index"],
                "Score": source["total_score"],
                "SourceNote": item["source_note"],
                "RecruitPostName": source["title"],
                "BusinessLine": source["business_line"],
                "LocationName": source["location"],
                "LastUpdateTime": source["publish_date"],
                "PostURL": source["post_url"],
                "ManualMatchReason": item["match_reason"],
                "PotentialGap": item["gap"],
                "Responsibility": source["responsibility"],
                "Requirement": source["requirement_text"],
            }
        )

    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(output_rows[0].keys()))
        writer.writeheader()
        writer.writerows(output_rows)

    print(OUTPUT_CSV)
    print(f"rows={len(output_rows)}")


if __name__ == "__main__":
    main()
