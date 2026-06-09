from __future__ import annotations

import csv
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_CSV = BASE_DIR / "meituan_jobs_ai_pm_full_detail_candidates.csv"


def build_jd_text(responsibility: str, requirement_text: str) -> str:
    parts: list[str] = []
    if responsibility.strip():
        parts.append(f"岗位职责：\n{responsibility.strip()}")
    if requirement_text.strip():
        parts.append(f"岗位基本要求：\n{requirement_text.strip()}")
    return "\n\n".join(parts)


ROWS = [
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "LongCat大模型 - Agent 评测产品经理（欢迎算法/工程转型）",
        "business_line": "核心本地商业-基础研发平台",
        "location": "北京市、上海市",
        "publish_date": "2026-05-29",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4301295312&highlightType=social",
        "responsibility": (
            "围绕 OpenClaw、Claude Code 等主流 Agent 框架设计长程任务评测体系，"
            "覆盖 Coding、数据分析等生产力场景的端到端评测流程、自动化数据生产与 Rubrics pipeline，"
            "并建立“评测-归因-策略建议-效果验证”的闭环。"
        ),
        "requirement_text": (
            "本科及以上，1年以上大模型评测或智能体应用落地经验；"
            "对评测科学性、观测与数据闭环敏感，理解 Agent 工具链演进；"
            "优先技术背景、理解大模型/Agent 机制、能熟练用 AI 提效。"
        ),
        "experience_text": "3年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "LongCat大模型 - 大模型评测平台产品经理",
        "business_line": "核心本地商业-基础研发平台",
        "location": "北京市、上海市",
        "publish_date": "2026-05-29",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=3506281745&highlightType=social",
        "responsibility": (
            "主导评测平台核心功能迭代，包括训练追踪、评测集管理、评测实验自动化、"
            "多维报表与动态榜单，建设可追溯、可复现的评测流程与指标稳定性监控体系，"
            "并协同算法/工程团队提升评测全链路实验人效。"
        ),
        "requirement_text": (
            "要求强产品思维、用户洞察和数据分析能力，能通过指标波动与失败率定位系统瓶颈；"
            "熟悉大模型评测技术栈与主流评测框架；"
            "优先有大模型评测/实验平台产品经验、开发基础或大模型落地案例。"
        ),
        "experience_text": "3年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "AI应用产品经理（B端）",
        "business_line": "核心本地商业-美团平台",
        "location": "北京市",
        "publish_date": "2026-05-19",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=3343483756&highlightType=social",
        "responsibility": (
            "负责商业分析场景下 Agent 产品的评测体系构建与持续迭代，"
            "覆盖评估方法论、标准、Benchmark 与工具平台设计；"
            "同时基于线上 AB、用户数据与评估报告发现问题并推动跨团队优化。"
        ),
        "requirement_text": (
            "要求2年以上 AIGC/AI 产品应用经验，优先 toB AI 助手或 AI 预测方向；"
            "对数据变化敏感，能快速定位问题、设计验证方案；"
            "了解 AI Agent 原理、关注前沿动态并能推动复杂项目落地。"
        ),
        "experience_text": "2年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "小团Agent AI Builder",
        "business_line": "核心本地商业-美团平台",
        "location": "北京市",
        "publish_date": "2026-06-05",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=3777123757&highlightType=social",
        "responsibility": (
            "负责小团具体场景的 Agent 日常迭代，不只写需求，还要参与上下文策略、"
            "Prompt Engineering 编排、模型数据合成与本地 Demo 跑通；"
            "并独立主导 Badcase 评测、归因、调优与端到端交付闭环。"
        ),
        "requirement_text": (
            "要求3年以上 Agent 产品经验，优先有 Agent/对话式 AI 端到端交付经历；"
            "强调 AI Builder 基因，要求能在产品设计与代码/算法细节间切换，"
            "具备跑代码、Prompt 调优或自动化工作流构建经验。"
        ),
        "experience_text": "3年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "闪购-商家端产品经理（经营工具方向）",
        "business_line": "核心本地商业-闪购事业部",
        "location": "北京市",
        "publish_date": "2026-04-06",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=3839496996&highlightType=social",
        "responsibility": (
            "聚焦商家经营工具方向，围绕商品管理、经营分析、预警诊断等场景设计 AI 应用策略与产品机制；"
            "定义 AI Agent 交互策略、分层工具策略与效果评估体系，"
            "并协同工程、算法、运营推动智能经营工具落地。"
        ),
        "requirement_text": (
            "要求本科及以上，有4年以上产品经验，优先 B 端商家端/经营工具/O2O 工具类背景；"
            "能将 AI 能力与商家经营逻辑结合，设计可落地、可收敛、可评估的策略方案；"
            "对数据和业务敏感。"
        ),
        "experience_text": "3年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "SaaS-餐饮门店系统产品经理",
        "business_line": "软硬件服务-餐饮SaaS事业部",
        "location": "成都市",
        "publish_date": "2026-05-06",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4257328451&highlightType=social",
        "responsibility": (
            "负责餐饮 SaaS 门店系统产品能力建设，深入商家经营痛点持续迭代优化；"
            "积极探索 AI 技术在门店经营场景中的落地，包含智能经营分析、AI 辅助决策、自动化运营等方向。"
        ),
        "requirement_text": (
            "要求本科及以上，具备 B 端产品设计经验，SaaS 经验更优；"
            "要有需求分析、产品设计、项目管理和数据分析能力；"
            "理解大模型、AI Agent 等主流 AI 工具及产品形态，能结合业务提出产品方案。"
        ),
        "experience_text": "1年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "履约服务及安全治理产品经理",
        "business_line": "核心本地商业-到家履约平台",
        "location": "北京市",
        "publish_date": "2026-03-31",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4058240729&highlightType=social",
        "responsibility": (
            "围绕骑手履约过程中的交接摩擦、安全治理等问题建设策略和工具产品，"
            "覆盖判责、申诉、处置等能力，并探索利用大模型推理判责、骑手申诉 Agent 等 AI 形态改善治理效率。"
        ),
        "requirement_text": (
            "要求本科及以上，2年以上互联网产品经验，优先 AI 产品经验或平台服务/安全治理策略工具背景；"
            "具备较强数据分析、业务洞察、结构化思维与协同推动能力，能够深度理解并运用 AI。"
        ),
        "experience_text": "2年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "交易履约产品经理",
        "business_line": "核心本地商业-美团平台",
        "location": "北京市",
        "publish_date": "2026-03-24",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4061597370&highlightType=social",
        "responsibility": (
            "负责兼职频道交易履约全链路产品规划与设计，覆盖供给上单、支付交易、履约售后等核心模块；"
            "并建设订单中心、履约监控、规则引擎等中台与工具能力，支持业务规模化运营。"
        ),
        "requirement_text": (
            "要求3年以上交易履约、订单系统或售后相关产品经验；"
            "需要理解交易结算与履约售后需求，具备数据敏感度与跨团队推进能力；"
            "优先具备 AI 产品思维，能结合大模型/AI Agent 优化体验。"
        ),
        "experience_text": "2年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "无人车业务部-营销产品经理",
        "business_line": "软硬件服务-无人车业务部",
        "location": "北京市",
        "publish_date": "2026-05-25",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4260189790&highlightType=social",
        "responsibility": (
            "负责无人车配送用户增长与营销平台化建设，覆盖拉新、激活、留存、召回、"
            "券类促销、投放触达、多触点营销体系与 ROI 归因；"
            "结合 AI 个性化推荐与用户行为数据推动从规则驱动到模型驱动的营销升级。"
        ),
        "requirement_text": (
            "要求3年以上增长/营销/电商类产品经验，具备复杂项目全生命周期管理与数据分析能力；"
            "优先了解机器学习/推荐算法原理，具备营销中台或平台化产品设计经验。"
        ),
        "experience_text": "3年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "产品经理",
        "business_line": "核心本地商业-美团平台",
        "location": "北京市",
        "publish_date": "2026-04-28",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4131315764&highlightType=social",
        "responsibility": (
            "负责 Push 承接页面设计与迭代，联动商业化供给、权益玩法和算法策略提升访购率与收入；"
            "并探索结合大模型/AI Agent 做产品智能化、辅助决策或智能交互。"
        ),
        "requirement_text": (
            "要求3年以上互联网产品经验，优先本地生活/商业化增长背景；"
            "需要理解用户分层、具备转化类产品设计和数据分析能力；"
            "优先具备 AI 产品思维与 AI 工具辅助需求分析经验。"
        ),
        "experience_text": "3年",
    },
    {
        "company": "美团",
        "source_schema": "meituan_detail_ai_pm_20260609",
        "title": "无人车硬件产品经理 -货箱和物流设备",
        "business_line": "软硬件服务-无人车业务部",
        "location": "北京市、深圳市",
        "publish_date": "2026-06-09",
        "post_url": "https://zhaopin.meituan.com/web/position/detail?jobUnionId=4494984395&highlightType=social",
        "responsibility": (
            "负责配送无人车货箱模块与上下货场景的需求挖掘、方案设计、"
            "产品定义和跨团队落地，借助 AI 工具辅助行业分析、需求洞察与趋势研究。"
        ),
        "requirement_text": (
            "要求汽车/自动化/机械相关专业，3年以上货箱或物流自动化设备产品设计开发经验；"
            "优先具备 AI 工具辅助需求分析、文档撰写和行业研究经验。"
        ),
        "experience_text": "3年",
    },
]


def main() -> None:
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    normalized_rows = []
    for row in ROWS:
        current = dict(row)
        current["jd_text"] = build_jd_text(current["responsibility"], current["requirement_text"])
        normalized_rows.append(current)

    fieldnames = list(normalized_rows[0].keys())
    with OUTPUT_CSV.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(normalized_rows)

    print(OUTPUT_CSV)
    print(f"rows={len(normalized_rows)}")


if __name__ == "__main__":
    main()
