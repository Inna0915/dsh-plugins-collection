import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from core.markdown_preview import parse_markdown, preview_text  # noqa: E402


class MarkdownPreviewTest(unittest.TestCase):
    def test_renders_supported_markdown_without_markers(self):
        markdown = (
            "# 版本说明\n\n"
            "## 版本信息\n\n"
            "- **[project]** 1.3.0\n"
            "### 2026-08-27\n"
            "- **[wms]** feat: 功能\n"
        )
        rendered = preview_text(markdown)
        self.assertIn("版本说明", rendered)
        self.assertIn("• [project] 1.3.0", rendered)
        self.assertNotIn("#", rendered)
        self.assertNotIn("**", rendered)

    def test_assigns_heading_list_and_bold_styles(self):
        spans = parse_markdown("## 标题\n- **模块** 内容\n")
        self.assertTrue(any(span.text == "标题" and "h2" in span.styles for span in spans))
        self.assertTrue(any(span.text == "模块" and "bold" in span.styles for span in spans))
        self.assertTrue(any(span.text == "• " and "list_marker" in span.styles for span in spans))

    def test_preserves_unknown_syntax(self):
        self.assertEqual(preview_text("> 引用\n`code`\n"), "> 引用\n`code`\n")

    def test_empty_input(self):
        self.assertEqual(parse_markdown(""), [])
        self.assertEqual(preview_text(None), "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
