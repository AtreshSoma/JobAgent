"""Tests for the resume humanizer."""
from humanizer import has_banned_content, humanize


def test_replaces_em_and_en_dashes(humanizer_patterns):
    text = "Data\u2014driven results \u2013 measurable"
    out = humanize(text, humanizer_patterns)
    assert "\u2014" not in out
    assert "\u2013" not in out
    assert "Data, driven results - measurable" == out


def test_removes_banned_phrases(humanizer_patterns):
    text = "I am a results-driven professional who can leverage synergies."
    out = humanize(text, humanizer_patterns)
    assert "results-driven professional" not in out.lower()
    assert "leverage synergies" not in out.lower()


def test_collapses_exclamations_and_whitespace(humanizer_patterns):
    text = "Wow!!!   Great    work\n\n\n\nhere"
    out = humanize(text, humanizer_patterns)
    assert "!!!" not in out
    assert "   " not in out
    assert "\n\n\n" not in out


def test_has_banned_content(humanizer_patterns):
    assert has_banned_content("uses an em dash \u2014 here", humanizer_patterns) is True
    assert has_banned_content("clean professional text", humanizer_patterns) is False


def test_removes_banned_phrases_only_as_whole_words():
    patterns = {"bannedPhrases": ["guru", "rockstar"]}
    out = humanize("Based in Gurugram. A true rockstar.", patterns)
    assert "Gurugram" in out
    assert "rockstar" not in out.lower()
    assert has_banned_content("Based in Gurugram", patterns) is False
