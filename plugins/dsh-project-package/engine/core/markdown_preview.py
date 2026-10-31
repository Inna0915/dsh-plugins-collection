"""版本说明所需的轻量 Markdown 解析。"""
from __future__ import annotations

import re
import string
from dataclasses import dataclass

_HEADING = re.compile(r"^(#{1,3})\s+(.*)$")
_LIST_ITEM = re.compile(r"^\s*[-*+]\s+(.*)$")
_BOLD = re.compile(r"\*\*(.+?)\*\*")


@dataclass(frozen=True)
class PreviewSpan:
    text: str
    styles: tuple[str, ...] = ()


def _inline_spans(text: str, base_styles: tuple[str, ...]) -> list[PreviewSpan]:
    spans: list[PreviewSpan] = []
    plain = ""
    position = 0
    while position < len(text):
        char = text[position]
        if char == "\\" and position + 1 < len(text) and text[position + 1] in string.punctuation:
            plain += text[position + 1]
            position += 2
            continue
        if char == "`":
            end = text.find("`", position + 1)
            if end >= 0:
                plain += text[position:end + 1]
                position = end + 1
                continue
        if text.startswith("**", position):
            end = position + 2
            while end < len(text):
                if text[end] == "\\":
                    end += 2
                elif text.startswith("**", end):
                    break
                else:
                    end += 1
            if end < len(text) and end > position + 2:
                if plain:
                    spans.append(PreviewSpan(plain, base_styles))
                    plain = ""
                spans.extend(_inline_spans(text[position + 2:end], (*base_styles, "bold")))
                position = end + 2
                continue
        plain += char
        position += 1
    if plain:
        spans.append(PreviewSpan(plain, base_styles))
    return spans


def parse_markdown(markdown: str | None) -> list[PreviewSpan]:
    """解析标题、列表和粗体；未知语法按普通文本保留。"""
    if not markdown:
        return []

    spans: list[PreviewSpan] = []
    for line in markdown.splitlines(keepends=True):
        content = line.rstrip("\r\n")
        newline = line[len(content):]
        heading = _HEADING.match(content)
        if heading:
            style = f"h{len(heading.group(1))}"
            spans.extend(_inline_spans(heading.group(2), (style,)))
            if newline:
                spans.append(PreviewSpan(newline, (style,)))
            continue

        item = _LIST_ITEM.match(content)
        if item:
            spans.append(PreviewSpan("• ", ("list", "list_marker")))
            spans.extend(_inline_spans(item.group(1), ("list",)))
            if newline:
                spans.append(PreviewSpan(newline, ("list",)))
            continue

        spans.extend(_inline_spans(content, ()))
        if newline:
            spans.append(PreviewSpan(newline))
    return spans


def preview_text(markdown: str | None) -> str:
    """返回隐藏受支持 Markdown 标记后的可见文本。"""
    return "".join(span.text for span in parse_markdown(markdown))
