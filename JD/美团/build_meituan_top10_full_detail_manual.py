from __future__ import annotations

import csv
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SOURCE_CSV = BASE_DIR / "meituan_jobs_full_detail_candidates_评分结果.csv"
OUTPUT_CSV = BASE_DIR / "meituan_jobs_产品经理_top10_人工筛选_全详情版.csv"
SELECTION_METHOD = (
    "执行日2026-06-09；美团全详情岗位池（31条详情页，含美团.txt中的share-position职位和补充核实的详情页）"
    "+近3个月/学历规则硬过滤+豆包评分+人工复核"
)


TOP10 = [
    {
        "title": "AI应用产品经理（B端）",
        "rank": 1,
        "tier": "主投",
        "match_reason": (
            "这是全详情池里最适合你的岗位。它本质上是 B 端 AI Agent 应用产品岗，核心是评测体系、数据分析、跨团队推进和产品优化。"
            "你做过企业级 AI 中台、商机评分、运维智能体和多场景 Agent 落地，既懂业务闭环，也能和算法/工程对话，迁移成本比美团其他岗位小很多。"
        ),
        "gap": "短板是商业分析场景和评测体系的直接经验还不够强，且岗位写明有 2 年以上相关经验，你要把现有项目包装成可验证的 AI 应用产品实战。",
    },
    {
        "title": "LongCat大模型 - Agent 评测产品经理（欢迎算法/工程转型）",
        "rank": 2,
        "tier": "主投",
        "match_reason": (
            "这是第二适合你的岗位。它强调 Agent 评测、长程任务、数据闭环、Rubrics、框架跟踪和生产力场景，你现有经历里最能复用的是"
            "“流程拆解 - Agent 串联 - 人工复核 - 持续优化”这一整套方法论，尤其适合把合同审核、商机评分、运维智能体经验翻译成评测语言来讲。"
        ),
        "gap": "缺少大模型评测体系和 Coding/数据分析生产力场景的直接项目，需要提前准备任务成功率、过程指标和 badcase 归因方法。",
    },
    {
        "title": "LongCat大模型 - 大模型评测平台产品经理",
        "rank": 3,
        "tier": "主投",
        "match_reason": (
            "这条更偏平台型产品经理，要求把训练追踪、评测集管理、实验自动化、报表系统和评测效率做成平台。你在集团 AI 中台、统一接入层、"
            "权限治理、监控日志和多场景复用上的经验，和它要的平台抽象能力高度同构。"
        ),
        "gap": "没有大模型评测平台的直接项目名头，面试里要把你做过的监控、分析、反馈闭环讲成平台能力，不要只讲单点业务成果。",
    },
    {
        "title": "LongCat - 大模型数据运营",
        "rank": 4,
        "tier": "次选",
        "match_reason": (
            "这条虽然不是标准 PM，但它和 Agent 评测、标注体系、数据质量、效果分析强相关。你理解智能体能力边界，也做过 AI 产品效果闭环，"
            "如果愿意接受“产品向数据运营/评测”靠拢的转法，这条比纯算法岗可投性高。"
        ),
        "gap": "缺少正式的大模型标注和评测运营经历，岗位本身也偏数据运营而不是产品经理，需要你接受角色边界变化。",
    },
    {
        "title": "产品经理",
        "rank": 5,
        "tier": "次选",
        "match_reason": (
            "这是美团平台的通用产品经理岗，包含 AI/大模型能力探索，但本质还是 C 端商业化增长。它的优点是职位序列标准、门槛清晰，"
            "你可以用“问题发现、策略设计、算法协同、AI辅助决策”这些能力去竞争。"
        ),
        "gap": "核心短板是本地生活和商业化增长经验不足，且它更偏 C 端增长，不适合当主攻岗，只建议作为平台通道补位。",
    },
    {
        "title": "LongCat - 大模型数据策略运营",
        "rank": 6,
        "tier": "次选",
        "match_reason": (
            "这条偏 Coding 场景的数据策略与运营，但至少仍在大模型、代码数据、评测、质量闭环这条线上。相比纯基础设施和算法研发岗，"
            "它更看重对 AI 能力和数据流程的理解，与你的转化路径稍微顺一点。"
        ),
        "gap": "你的核心经历是产品，不是数据运营，更不是代码数据生产；如果投这条，要接受岗位中心从“做产品”转成“做数据/评测运营”。",
    },
    {
        "title": "LongCat - 大模型自进化与自动化研究智能体研究员",
        "rank": 7,
        "tier": "保底",
        "match_reason": (
            "这条的主题和你对 Agent、长任务、工具调用、自动化研究工作流的兴趣高度一致，所以从兴趣和方向上不算偏。"
            "如果团队愿意接受强产品思维、会动手做原型的人，它是极少数你能在业务语言上接住的研究岗。"
        ),
        "gap": "岗位本质是研究员，要求算法功底、框架经验、论文/开源背景，你当前背景不满足核心门槛，只能作为极低优先级冲一冲。",
    },
    {
        "title": "LongCat - 通用 agent 算法研究员",
        "rank": 8,
        "tier": "保底",
        "match_reason": (
            "从方向上说，这条是 LongCat 里最贴近通用 Agent 产品形态和能力边界的一类岗位，你对 Agent 产品设计与工作流的理解能帮助你看懂它在做什么。"
        ),
        "gap": "问题也很明确：它是强化学习和大模型训练导向的算法研究岗，不是产品岗。没有对应算法研究背景的话，基本不应作为重点投递。",
    },
    {
        "title": "LongCat - Pretrain Infra AI 工程师",
        "rank": 9,
        "tier": "保底",
        "match_reason": (
            "这条之所以还能进前十，不是因为真的合适，而是因为硬过滤后可用池子里可投岗位本来就不多。它至少和 LLM、Alignment、RAG、"
            "工程落地相关，你在产品工程侧有一点共鸣。"
        ),
        "gap": "岗位核心是分布式训练、CUDA、训练框架和Infra，不属于你的求职方向。正常情况下不建议投，只作为结果榜单中的低优先级补位。",
    },
    {
        "title": "LongCat - 异构算力 AI 工程师",
        "rank": 10,
        "tier": "保底",
        "match_reason": (
            "这条也是因为池子稀疏才进入前十。它和 AI 基础设施、大模型平台相关，算是还在同一技术大方向里。"
        ),
        "gap": "岗位核心是异构算力、PyTorch分布式、NCCL、CUDA、Kernel和Benchmark，这些都不是你的能力主轴，实操匹配度很低，不建议投入太多时间。",
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
                "SelectionTier": item["tier"],
                "SelectionMethod": SELECTION_METHOD,
                "SourceRowIndex": source["source_row_index"],
                "Score": source["total_score"],
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
