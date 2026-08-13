"""JLPT level lookup.

This is a seed list, not a complete dataset. It covers common vocabulary so the
highlight pipeline can be exercised end to end; a full JLPT vocabulary dataset
should replace `SEED` before this is user-facing.

Levels are ordered by difficulty: N5 is easiest, N1 hardest.
"""

LEVELS = ("N5", "N4", "N3", "N2", "N1")

_DIFFICULTY = {level: i for i, level in enumerate(LEVELS)}

# dictionary form -> JLPT level
SEED: dict[str, str] = {
    # N5 — nouns
    "日本語": "N5", "人": "N5", "友達": "N5", "先生": "N5", "学生": "N5",
    "学校": "N5", "会社": "N5", "家": "N5", "国": "N5", "今日": "N5",
    "明日": "N5", "昨日": "N5", "時間": "N5", "年": "N5", "月": "N5",
    "日": "N5", "水": "N5", "本": "N5", "車": "N5", "駅": "N5",
    "町": "N5", "山": "N5", "空": "N5", "手": "N5", "目": "N5",
    "名前": "N5", "電話": "N5", "映画": "N5", "音楽": "N5", "食べ物": "N5",
    # N5 — verbs
    "する": "N5", "いる": "N5", "ある": "N5", "行く": "N5", "来る": "N5",
    "見る": "N5", "食べる": "N5", "飲む": "N5", "書く": "N5", "読む": "N5",
    "話す": "N5", "聞く": "N5", "買う": "N5", "会う": "N5", "帰る": "N5",
    "待つ": "N5", "作る": "N5", "使う": "N5", "住む": "N5", "働く": "N5",
    "言う": "N5", "思う": "N5", "分かる": "N5", "知る": "N5",
    # N5 — adjectives and adverbs
    "大きい": "N5", "小さい": "N5", "新しい": "N5", "古い": "N5", "良い": "N5",
    "悪い": "N5", "高い": "N5", "安い": "N5", "早い": "N5", "遅い": "N5",
    "面白い": "N5", "楽しい": "N5", "難しい": "N5", "易しい": "N5",
    "好き": "N5", "嫌い": "N5", "元気": "N5", "静か": "N5", "有名": "N5",
    "とても": "N5", "少し": "N5", "たくさん": "N5", "よく": "N5", "また": "N5",
    # N4
    "勉強": "N4", "説明": "N4", "経験": "N4", "生活": "N4", "文化": "N4",
    "社会": "N4", "自分": "N4", "気持ち": "N4", "理由": "N4", "用意": "N4",
    "始める": "N4", "終わる": "N4", "続ける": "N4", "変わる": "N4", "決める": "N4",
    "覚える": "N4", "忘れる": "N4", "調べる": "N4", "比べる": "N4", "考える": "N4",
    "急ぐ": "N4", "選ぶ": "N4", "運ぶ": "N4", "届く": "N4", "光る": "N4",
    "大切": "N4", "便利": "N4", "簡単": "N4", "特別": "N4", "必要": "N4",
    # N3
    "影響": "N3", "状況": "N3", "判断": "N3", "解決": "N3", "提案": "N3",
    "感覚": "N3", "表現": "N3", "内容": "N3", "関係": "N3", "結果": "N3",
    "確認": "N3", "成功": "N3", "失敗": "N3", "努力": "N3", "希望": "N3",
    # N2
    "傾向": "N2", "背景": "N2", "課題": "N2", "対象": "N2", "評価": "N2",
    "実現": "N2", "維持": "N2", "促進": "N2", "把握": "N2", "検討": "N2",
    # N1
    "概念": "N1", "妥当": "N1", "顕著": "N1", "抽象": "N1", "洞察": "N1",
}


def level_of(dictionary_form: str, surface: str) -> str | None:
    """Return the JLPT level of a word, or None if it isn't in the seed list."""
    return SEED.get(dictionary_form) or SEED.get(surface)


def is_at_or_above(token_level: str | None, user_level: str | None) -> bool:
    """Whether a token is worth highlighting for a learner at `user_level`.

    An unknown level counts as harder than anything known — words missing from
    the seed list are exactly the ones a learner is least likely to know. That
    also means highlight coverage is only as good as `SEED`; with the seed list
    alone, most content words highlight.
    """
    if token_level is None:
        return True
    if user_level not in _DIFFICULTY:
        return True
    return _DIFFICULTY[token_level] >= _DIFFICULTY[user_level]
