from __future__ import annotations

import csv
from pathlib import Path


SELECTION_METHOD = "执行日2026-06-09；百度社招产品岗全量抓取+近3个月过滤+排除5年以上+豆包Top50初筛后人工复核"

SELECTED_TITLES = [
    "AI产品经理（智能体方向）（J98909）",
    "DuMate产品经理（J100378）",
    "DuMate效果评测产品经理（J100354）",
    "客服质培平台产品经理（J98408）",
    "AI全栈产品经理（J100130）",
    "伐谋-OPC创新产品经理（J97230）",
    "商家Ai agent产品经理（J99223）",
    "Agent产品经理（电商方向）（J99416）",
    "ToB互动数字人产品经理（J98821）",
    "DuMate评测产品经理（J99493）",
]

MANUAL_REASONS = {
    "AI产品经理（智能体方向）（J98909）": "这是百度里和你现有履历最同构的一档岗位：Agent 产品规划、任务编排、工具调用、上下文管理、评估体系和跨团队推进，你在集团 AI 中台、云端智能体平台和多场景 Agent 落地里都已经做过，几乎可以一一映射。",
    "DuMate产品经理（J100378）": "这个岗位强调智能体搭建平台、工具/技能生态和平台型产品思维，和你做过的 AI 统一接入层、云端智能体工作台、模型路由与多场景复用很接近，既能讲平台治理，也能讲 Agent 产品从0到1落地。",
    "DuMate效果评测产品经理（J100354）": "你的优势不只是做功能，更在于把 Agent 效果做成闭环。岗位里的长程任务评测、skill 建设、效果量化和问题整改，能直接对应你在合同审核、运维智能体、商机评分里做过的评估指标、人工复核和持续优化路径。",
    "客服质培平台产品经理（J98408）": "虽然场景是客服质培，但岗位方法论和你非常接近：零代码平台、大模型、skills、规则设计、数据看板、闭环优化，本质上都是把 AI 能力嵌进复杂流程并形成可执行、可评估、可迭代的平台产品。",
    "AI全栈产品经理（J100130）": "这个岗位非常吃 AI 产品工程能力、Vibe Coding 和端到端落地，你的 Python、TypeScript、LangGraph、MCP/Skill、用 Claude Code/Codex 快速搭 MVP 的经历会很有说服力，属于能把简历技术面直接转成产品竞争力的岗位。",
    "伐谋-OPC创新产品经理（J97230）": "岗位要的不是传统 PRD 型 PM，而是能用 vibe coding 快速做 Demo、验证高价值场景的人。你现在做 AI 产品的方式就是先拆业务、再做 MVP、再闭环迭代，这一点和它的创新项目推进模式非常合拍。",
    "商家Ai agent产品经理（J99223）": "从 Agent 架构、Skillset、RAG、API 理解到 0-1 梳理模糊需求，这个岗位和你的技术栈与方法论都对得上。尤其“数字员工”交互和自动化工作流部分，很适合拿你现在的企业智能体、商机平台和运维场景去迁移表达。",
    "Agent产品经理（电商方向）（J99416）": "它考察的是复杂业务如何抽象成 Agent 工作流，以及如何搭建评估与优化机制，这正好对应你已经做过的工作流编排、工具调用、效果监控和方法论沉淀。即使不是同一行业，产品方法和技术抽象层是相通的。",
    "ToB互动数字人产品经理（J98821）": "这是前十里更偏 ToB 应用落地的一岗，强调企业场景、多模态交互、Agent 效果达标和体验评估。你在 ToB AI 产品推进、场景挖掘、效果复盘上的经验可以直接承接，只是需要把案例翻译成数字人/多模态语境。",
    "DuMate评测产品经理（J99493）": "这个岗位聚焦桌面端 Agent 评测体系、评测指标和评测闭环，和你现在做 AI 产品时强调“效果评估-问题分析-持续优化”的方法非常一致。相比一些偏行业背景的岗位，它更吃 Agent 理解、评测抽象和落地推动，这些都是你的强项。",
}

POTENTIAL_GAPS = {
    "AI产品经理（智能体方向）（J98909）": "需要补更强的互联网产品叙事，以及对通用 Agent/AI 编程工具类用户场景的竞品认知。",
    "DuMate产品经理（J100378）": "需要补开放平台、开发者生态和偏 C 端助手产品的增长逻辑表达。",
    "DuMate效果评测产品经理（J100354）": "需要补更系统的 Agent 长程任务评测方法论，以及 OpenClaw 类框架的案例表达。",
    "客服质培平台产品经理（J98408）": "需要补客服质检/培训领域的业务语言，把你现有流程提效案例翻译成客服质培闭环。",
    "AI全栈产品经理（J100130）": "岗位偏文库/网盘个人智能方向，需要补 ToC 用户体验、增长指标和个人效率场景语言。",
    "伐谋-OPC创新产品经理（J97230）": "需要补 OPC 或快消/零售/制造等行业案例，证明你不仅能做技术验证，也能做行业化产品抽象。",
    "商家Ai agent产品经理（J99223）": "需要补跨境电商、达人合作、商家经营链路等行业知识，避免被业务背景卡住。",
    "Agent产品经理（电商方向）（J99416）": "需要补电商策略和经营场景理解，把你的 Agent 经验提前翻译成电商工作流语言。",
    "ToB互动数字人产品经理（J98821）": "需要补数字人、多模态表现和语音/视觉交互相关认知，避免只停留在通用 Agent 经验层面。",
    "DuMate评测产品经理（J99493）": "需要补更明确的 Agent 评测集设计、评测指标和可复现流程表达，避免只讲功能产品、不讲评测方法。",
}


def main() -> int:
    base_dir = Path(__file__).resolve().parent
    source_path = base_dir / "baidu_jobs_产品岗_top50_模型初筛.csv"
    output_path = base_dir / "baidu_jobs_产品岗_top10_人工筛选.csv"

    with source_path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))

    row_map = {row["title"]: row for row in rows}
    missing = [title for title in SELECTED_TITLES if title not in row_map]
    if missing:
        raise KeyError(f"missing rows in top50 csv: {missing}")

    output_rows = []
    for rank, title in enumerate(SELECTED_TITLES, start=1):
        row = row_map[title]
        output_rows.append(
            {
                "Rank": str(rank),
                "SelectionMethod": SELECTION_METHOD,
                "SourceRowIndex": row["source_row_index"],
                "RecruitPostName": row["title"],
                "BusinessLine": row["business_line"],
                "LocationName": row["location"],
                "LastUpdateTime": row["publish_date"],
                "PostURL": row["post_url"],
                "ManualMatchReason": MANUAL_REASONS[title],
                "PotentialGap": POTENTIAL_GAPS[title],
                "Responsibility": row["responsibility"],
                "Requirement": row["requirement_text"],
            }
        )

    with output_path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(output_rows[0].keys()))
        writer.writeheader()
        writer.writerows(output_rows)

    print(output_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
