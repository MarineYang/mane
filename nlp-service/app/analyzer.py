"""Japanese morphological analysis backed by SudachiPy."""

from functools import lru_cache

from sudachipy import dictionary, tokenizer

from . import jlpt

# Split mode C keeps compounds together (日本語 stays one word instead of
# 日本 + 語), which matches how a learner thinks about vocabulary.
_SPLIT_MODE = tokenizer.Tokenizer.SplitMode.C

# Parts of speech that carry no learning value on their own. Particles and
# auxiliaries are grammar, not vocabulary, and punctuation is noise.
_SKIP_POS = {"助詞", "助動詞", "補助記号", "空白"}

_KATAKANA_START, _KATAKANA_END = 0x30A1, 0x30F6
_KANA_OFFSET = 0x60


@lru_cache(maxsize=1)
def _tokenizer():
    """Build the Sudachi tokenizer once — loading the dictionary is expensive."""
    return dictionary.Dictionary(dict="core").create()


def katakana_to_hiragana(text: str) -> str:
    """Sudachi returns readings in katakana; furigana is conventionally hiragana."""
    return "".join(
        chr(ord(ch) - _KANA_OFFSET) if _KATAKANA_START <= ord(ch) <= _KATAKANA_END else ch
        for ch in text
    )


def _utf16_offsets(text: str) -> list[int]:
    """Map each code-point index to its UTF-16 code-unit offset.

    Sudachi reports offsets in code points, but the extension slices the string
    in JavaScript, which counts UTF-16 code units. They diverge on any
    character outside the BMP (rare kanji, emoji) — without this, a single
    emoji in a subtitle line shifts every highlight after it.

    Returns a list of length len(text) + 1 so the end offset is addressable.
    """
    offsets = [0] * (len(text) + 1)
    total = 0
    for i, ch in enumerate(text):
        offsets[i] = total
        total += 2 if ord(ch) > 0xFFFF else 1
    offsets[len(text)] = total
    return offsets


def analyze(text: str, level: str | None = None) -> list[dict]:
    """Tokenize one sentence into learner-facing tokens."""
    if not text:
        return []

    offsets = _utf16_offsets(text)
    tokens = []

    for m in _tokenizer().tokenize(text, _SPLIT_MODE):
        surface = m.surface()
        if not surface.strip():
            continue

        pos = m.part_of_speech()[0]
        lemma = m.dictionary_form()
        reading = katakana_to_hiragana(m.reading_form())

        token_level = jlpt.level_of(lemma, surface)
        highlight = pos not in _SKIP_POS and jlpt.is_at_or_above(token_level, level)

        tokens.append(
            {
                "surface": surface,
                # Readings are only useful where they differ from the surface
                # (i.e. the word contains kanji).
                "reading": reading if reading and reading != surface else "",
                "lemma": lemma,
                "pos": pos,
                "jlpt": token_level or "",
                "gloss": "",  # populated once a dictionary (JMdict) is wired in
                "start": offsets[m.begin()],
                "end": offsets[m.end()],
                "highlight": highlight,
            }
        )

    return tokens
