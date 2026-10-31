"""仅在组合后的说明中补默认 scope，不改服务原文或产品资源。"""
import re

_BARE = re.compile(r"^(feat|fix)(!|\\!)?(?=:|\s)")
_ITEM = re.compile(r"^(\s*[-*+]\s+)(.*)$")


def default_scope(message: str, scope: str) -> str:
    if not scope:
        return message
    match = _BARE.match(message)
    if not match or message[match.end():].lstrip().startswith(("(", "\\(")):
        return message
    return (match.group(1) + f"({scope})" + (match.group(2) or "")
            + message[match.end():])


def scoped_release(markdown: str, scope: str) -> str:
    lines = []
    fenced = False
    for line in markdown.splitlines():
        if line.lstrip().startswith(("```", "~~~")):
            fenced = not fenced
        item = _ITEM.match(line) if not fenced else None
        lines.append(item.group(1) + default_scope(item.group(2), scope) if item else line)
    return "\n".join(lines)
