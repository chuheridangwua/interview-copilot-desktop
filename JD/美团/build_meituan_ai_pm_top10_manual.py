from __future__ import annotations

import csv
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
SCORED_CSV = BASE_DIR / "meituan_jobs_ai_pm_full_detail_candidates_评分结果.csv"
OUTPUT_CSV = BASE_DIR / "meituan_jobs_ai_pm_top10_人工筛选_全详情_简历对齐.csv"


MANUAL_ORDER = [
    {
        "title": "AI应用产品经理（B端）",
        "reason": "最贴近简历主线：ToB AI应用、Agent评测体系、数据分析与跨团队落地，和你做企业AI场景闭环的经历最接近。",
        "gap": "偏商业分析评测场景，需补美团内部业务指标体系和 Benchmark 设计细节。",
    },
    {
        "title": "LongCat大模型 - Agent 评测产品经理（欢迎算法/工程转型）",
        "reason": "强匹配 Agent、评测、归因和效果闭环，与你做多 Agent 审核、AI质量可控和反馈闭环的经历高度相关。",
        "gap": "需要补生产力场景评测方法论，以及更系统的大模型评测经验表达。",
    },
    {
        "title": "小团Agent AI Builder",
        "reason": "强调 AI Builder、Prompt 编排、Badcase 归因和本地 Demo 跑通，和你“产品+工程”复合能力很对口。",
        "gap": "更偏 C 端本地生活场景，且要求较强 hands-on 工程参与度，需准备场景迁移说法。",
    },
    {
        "title": "LongCat大模型 - 大模型评测平台产品经理",
        "reason": "平台化、实验追踪、报表、评测流程可追溯等要求，和你做 AI 中台、监控评估、统一接入层的经历有较强同构。",
        "gap": "需要补大模型评测平台专业术语、主流框架和实验管理经验表述。",
    },
    {
        "title": "闪购-商家端产品经理（经营工具方向）",
        "reason": "虽然不是纯 AI title，但核心是 B 端经营工具、AI Agent、分析预警和效果评估，和你商机平台、智能审核类产品的思路接近。",
        "gap": "本地零售商家经营工具和 O2O 场景积累不足，且岗位文案里隐含更高年限预期。",
    },
    {
        "title": "SaaS-餐饮门店系统产品经理",
        "reason": "B 端 SaaS、经营分析、AI辅助决策、自动化运营这些要求和你的企业AI落地经验有明显交集，迁移路径比较自然。",
        "gap": "需要补餐饮门店系统、收银/经营系统和行业细节理解。",
    },
    {
        "title": "履约服务及安全治理产品经理",
        "reason": "平台治理、判责、申诉、Agent 形态探索等方向，与你做复杂流程拆解、规则治理和 AI 辅助决策能力有一定对应。",
        "gap": "履约安全治理业务域较陌生，需要提前补判责/申诉/治理指标体系。",
    },
    {
        "title": "交易履约产品经理",
        "reason": "交易履约中台、订单中心、规则引擎这类平台抽象能力与你做企业内部流程平台化有方法论相通之处。",
        "gap": "AI 不是核心要求，且缺少交易履约、支付售后等业务沉淀，优先级应低于前面岗位。",
    },
    {
        "title": "产品经理",
        "reason": "仍有 AI Agent 和数据驱动优化要求，能作为美团平台产品线的保底可投岗位。",
        "gap": "岗位本质更偏 C 端增长和商业化转化，不是你简历里的强项方向。",
    },
    {
        "title": "无人车业务部-营销产品经理",
        "reason": "有平台化、ROI 归因、模型驱动营销闭环等要求，方法论上可迁移，适合作为尾部备选。",
        "gap": "营销增长和无人车业务域迁移成本高，只建议放在末位保底。",
    },
]


def load_rows(path: Path) -> dict[str, dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return {row["title"]: row for row in csv.DictReader(handle)}


def main() -> None:
    source_rows = load_rows(SCORED_CSV)
    output_rows: list[dict[str, str]] = []

    for index, config in enumerate(MANUAL_ORDER, start=1):
        row = source_rows[config["title"]]
        output_rows.append(
            {
                "Rank": str(index),
                "company": row["company"],
                "RecruitPostName": row["title"],
                "BusinessLine": row["business_line"],
                "LocationName": row["location"],
                "LastUpdateTime": row["publish_date"],
                "PostURL": row["post_url"],
                "Responsibility": row["responsibility"],
                "Requirement": row["requirement_text"],
                "ModelScore": row["total_score"],
                "ModelVerdict": row["verdict"],
                "ManualMatchReason": config["reason"],
                "PotentialGap": config["gap"],
            }
        )

    fieldnames = list(output_rows[0].keys())
    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(output_rows)

    print(OUTPUT_CSV)
    print(f"rows={len(output_rows)}")


if __name__ == "__main__":
    main()
