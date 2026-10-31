import { parseDocument } from "htmlparser2";
import {
  isTag,
  isText,
  hasChildren,
  type AnyNode,
  type Element,
} from "domhandler";
import { decodeHTML } from "entities";
import type { Region, Section } from "../types.js";

type Node = AnyNode;
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function children(node: Node): Node[] {
  return hasChildren(node) ? node.children : [];
}
function elements(nodes: Node[]): Element[] {
  return nodes.filter(isTag);
}
function textOf(node: Node): string {
  if (node.type === "cdata") {
    return children(node)
      .map((child) => (isText(child) ? child.data : textOf(child)))
      .join("");
  }
  return isText(node)
    ? decodeHTML(node.data)
    : children(node).map(textOf).join("");
}
function descendants(
  nodes: Node[],
  match: (node: Element) => boolean,
): Element[] {
  const result: Element[] = [];
  for (const node of nodes) {
    if (isTag(node) && match(node)) {
      result.push(node);
    }
    result.push(...descendants(children(node), match));
  }
  return result;
}
function macro(node: Node, name?: string): boolean {
  return (
    isTag(node) &&
    ["ac:structured-macro", "ac:macro"].includes(node.name) &&
    (!name || node.attribs["ac:name"] === name)
  );
}
function params(node: Element): Record<string, string> {
  return Object.fromEntries(
    elements(children(node))
      .filter((child) => child.name === "ac:parameter")
      .map((child) => [child.attribs["ac:name"] || "", textOf(child)]),
  );
}
function body(node: Element): Node[] {
  return elements(children(node))
    .filter((child) =>
      ["ac:rich-text-body", "ac:plain-text-body"].includes(child.name),
    )
    .flatMap(children);
}
function safeUrl(value: string, baseUrl: string): string {
  try {
    const url = new URL(value, baseUrl || "https://example.invalid/");
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}
const paragraphTags = new Set(["p", "div", "section", "blockquote"]);
const supportedTags = new Set([
  "a",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "del",
  "strike",
  "code",
  "pre",
  "br",
  "hr",
  "p",
  "div",
  "span",
  "section",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "tbody",
  "thead",
  "tfoot",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ac:layout",
  "ac:layout-section",
  "ac:layout-cell",
  "ac:rich-text-body",
  "ac:plain-text-body",
  "ac:parameter",
  "ac:link",
  "ac:link-body",
  "ac:plain-text-link-body",
  "ac:image",
  "ri:page",
  "ri:attachment",
  "ri:user",
  "ri:url",
]);

export function analyzeStorage(
  storage: string,
  baseUrl = "",
  options: { html?: boolean; details?: boolean } = {},
) {
  const doc = parseDocument(storage, {
    xmlMode: true,
    withStartIndices: true,
    withEndIndices: true,
    decodeEntities: false,
  });
  for (const node of descendants(doc.children, () => true)) {
    for (const key of Object.keys(node.attribs)) {
      node.attribs[key] = decodeHTML(node.attribs[key]);
    }
  }
  const warnings = new Set<string>();
  const lossyNodes = new Set<Node>();
  const mark = (node: Node, reason: string) => {
    lossyNodes.add(node);
    warnings.add(reason);
  };
  function wiki(node: Node, list = ""): string {
    if (node.type === "cdata") {
      return textOf(node);
    }
    if (isText(node)) {
      return decodeHTML(node.data);
    }
    if (!isTag(node)) {
      return children(node)
        .map((child) => wiki(child, list))
        .join("");
    }
    const name = node.name;
    const inner = () =>
      children(node)
        .map((child) => wiki(child, list))
        .join("");
    if (macro(node)) {
      const kind = node.attribs["ac:name"] || "unknown";
      const values = params(node);
      if (kind === "toc") {
        return "{toc}\n";
      }
      if (kind === "anchor") {
        return `{anchor:${values[""] || ""}}`;
      }
      if (kind === "code" || kind === "noformat") {
        return `\n{${kind}${kind === "code" && values.language ? `:language=${values.language}` : ""}}\n${body(node).map(textOf).join("")}\n{${kind}}\n`;
      }
      if (
        [
          "info",
          "note",
          "warning",
          "tip",
          "expand",
          "panel",
          "section",
          "column",
        ].includes(kind)
      ) {
        const parameters = Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join("|");
        return `\n{${kind}${parameters ? ":" + parameters : ""}}\n${body(node)
          .map((child) => wiki(child, list))
          .join("")}\n{${kind}}\n`;
      }
      mark(
        node,
        `宏 ${kind} 保留在原始 storage；wiki 阅读表示不包含完整宏定义。`,
      );
      return `\n[宏 ${kind}：原始内容已保留]\n${body(node)
        .map((child) => wiki(child, list))
        .join("")}`;
    }
    if (/^h[1-6]$/.test(name)) {
      return `\n${name}. ${inner().trim()}\n\n`;
    }
    if (paragraphTags.has(name)) {
      return "\n" + inner() + "\n\n";
    }
    if (name === "br") {
      return "\\\\\n";
    }
    if (name === "hr") {
      return "\n----\n";
    }
    if (["strong", "b"].includes(name)) {
      return `*${inner()}*`;
    }
    if (["em", "i"].includes(name)) {
      return `_${inner()}_`;
    }
    if (name === "u") {
      return `+${inner()}+`;
    }
    if (["s", "strike", "del"].includes(name)) {
      return `-${inner()}-`;
    }
    if (name === "code") {
      return `{{${textOf(node)}}}`;
    }
    if (name === "pre") {
      return `\n{noformat}\n${textOf(node)}\n{noformat}\n`;
    }
    if (name === "ul" || name === "ol") {
      return (
        "\n" +
        children(node)
          .map((child) => wiki(child, list + (name === "ul" ? "*" : "#")))
          .join("") +
        "\n"
      );
    }
    if (name === "li") {
      return `${list || "*"} ${inner().trim()}\n`;
    }
    if (name === "table") {
      return "\n" + inner() + "\n";
    }
    if (name === "tr") {
      const cells = elements(children(node)).filter((child) =>
        ["td", "th"].includes(child.name),
      );
      const separator =
        cells.length && cells.every((cell) => cell.name === "th") ? "||" : "|";
      return (
        separator +
        cells
          .map((cell) =>
            wiki(cell)
              .trim()
              .replace(/\n+/g, " \\\\ ")
              .replace(/(?<!\\)\|/g, "\\|"),
          )
          .join(separator) +
        separator +
        "\n"
      );
    }
    if (name === "td" || name === "th") {
      if (
        Number(node.attribs.colspan || 1) > 1 ||
        Number(node.attribs.rowspan || 1) > 1
      ) {
        mark(node, "合并单元格在 wiki 中为阅读表示；原始表格结构保留。");
      }
      return inner();
    }
    if (name === "a") {
      return `[${inner() || node.attribs.href || ""}|${node.attribs.href || ""}]`;
    }
    if (name === "ac:link") {
      const refs = descendants(children(node), (child) =>
        child.name.startsWith("ri:"),
      );
      const ref = refs[0];
      const label = elements(children(node))
        .filter((child) => child.name.endsWith("link-body"))
        .map(textOf)
        .join("");
      if (ref?.name === "ri:page") {
        const target = `${ref.attribs["ri:space-key"] ? ref.attribs["ri:space-key"] + ":" : ""}${ref.attribs["ri:content-title"] || ""}`;
        return `[${label ? label + "|" : ""}${target}]`;
      }
      if (ref?.name === "ri:attachment") {
        return `[${label ? label + "|" : ""}^${ref.attribs["ri:filename"] || ""}]`;
      }
      if (ref?.name === "ri:user") {
        mark(node, "用户提及可能只有内部标识；更新其他区域将保留原提及。");
        return (
          label ||
          `@${ref.attribs["ri:username"] || ref.attribs["ri:userkey"] || "用户"}`
        );
      }
      if (node.attribs["ac:anchor"]) {
        return `[${label ? label + "|" : ""}#${node.attribs["ac:anchor"]}]`;
      }
      return label || inner();
    }
    if (name === "ac:image") {
      const ref = descendants(children(node), (child) =>
        ["ri:attachment", "ri:url"].includes(child.name),
      )[0];
      return `!${ref?.attribs["ri:filename"] || ref?.attribs["ri:value"] || "图片"}!`;
    }
    if (name.startsWith("ri:") || name === "ac:parameter") {
      return "";
    }
    if (!supportedTags.has(name)) {
      mark(node, `元素 ${name} 的特殊格式未完整转换为 wiki。`);
    }
    if (name === "ac:layout-section") {
      return "\n{section}\n" + inner() + "\n{section}\n";
    }
    if (name === "ac:layout-cell") {
      return "\n{column}\n" + inner() + "\n{column}\n";
    }
    return inner();
  }
  const headingNodes = descendants(doc.children, (node) =>
    /^h[1-6]$/.test(node.name),
  );
  function html(node: Node): string {
    if (node.type === "cdata") {
      return escapeHtml(textOf(node));
    }
    if (isText(node)) {
      return escapeHtml(decodeHTML(node.data));
    }
    if (!isTag(node)) {
      return children(node).map(html).join("");
    }
    const name = node.name;
    const inner = () => children(node).map(html).join("");
    if (macro(node)) {
      const kind = node.attribs["ac:name"] || "unknown";
      if (kind === "toc") {
        return (
          '<nav class="cf-native-toc">' +
          headingNodes
            .map(
              (heading) =>
                `<a href="#cf-h-${heading.startIndex}" style="padding-left:${(Number(heading.name[1]) - 1) * 12}px">${escapeHtml(textOf(heading))}</a>`,
            )
            .join("") +
          "</nav>"
        );
      }
      if (kind === "anchor") {
        return "";
      }
      if (["code", "noformat"].includes(kind)) {
        return `<pre><code>${escapeHtml(body(node).map(textOf).join(""))}</code></pre>`;
      }
      if (kind === "section" || kind === "column") {
        return `<div class="cf-macro-${kind}">${body(node).map(html).join("")}</div>`;
      }
      return `<aside class="cf-macro"><small>${escapeHtml(kind)}</small>${body(node).map(html).join("") || "<p>此宏请在 Confluence 原网页查看</p>"}</aside>`;
    }
    if (/^h[1-6]$/.test(name)) {
      return `<${name} id="cf-h-${node.startIndex}">${inner()}</${name}>`;
    }
    if (name === "ac:layout") {
      return `<div class="cf-layout">${inner()}</div>`;
    }
    if (name === "ac:layout-section") {
      const type = node.attribs["ac:type"];
      return `<div class="cf-layout-row${type === "two_right_sidebar" ? " cf-right-toc" : ""}">${inner()}</div>`;
    }
    if (name === "ac:layout-cell") {
      return `<div class="cf-layout-cell">${inner()}</div>`;
    }
    if (name === "a") {
      const url = safeUrl(node.attribs.href || "", baseUrl);
      return url
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${inner()}</a>`
        : inner();
    }
    if (name === "ac:link" || name === "ac:image") {
      return `<span class="cf-reference">${escapeHtml(wiki(node))}</span>`;
    }
    if (name.startsWith("ri:") || name === "ac:parameter") {
      return "";
    }
    if (["br", "hr"].includes(name)) {
      return `<${name}>`;
    }
    const tags = new Set([
      "p",
      "div",
      "span",
      "blockquote",
      "strong",
      "b",
      "em",
      "i",
      "u",
      "s",
      "del",
      "code",
      "pre",
      "ul",
      "ol",
      "li",
      "table",
      "tbody",
      "thead",
      "tfoot",
      "tr",
      "td",
      "th",
    ]);
    if (tags.has(name)) {
      const span = ["td", "th"].includes(name)
        ? ["colspan", "rowspan"]
            .map((attr) =>
              /^\d{1,3}$/.test(node.attribs[attr] || "")
                ? ` ${attr}="${node.attribs[attr]}"`
                : "",
            )
            .join("")
        : "";
      return `<${name}${span}>${inner()}</${name}>`;
    }
    return inner();
  }
  const contentWiki = doc.children
    .map((node) => wiki(node))
    .join("")
    .trim();
  const contentHtml =
    options.html === false ? "" : doc.children.map(html).join("");
  if (options.details === false) {
    return {
      wiki: contentWiki,
      html: contentHtml,
      warnings: [...warnings],
      lossy: lossyNodes.size > 0,
      sections: [] as Section[],
      regions: [] as Region[],
      defaultRegionId: undefined as string | undefined,
    };
  }
  function openEnd(node: Element): number {
    let quote = "";
    for (let i = node.startIndex!; i < storage.length; i++) {
      const char = storage[i];
      if (quote) {
        if (char === quote) {
          quote = "";
        }
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === ">") {
        return i + 1;
      }
    }
    throw new Error("页面容器标签不完整");
  }
  const regionNodes = descendants(
    doc.children,
    (node) => node.name === "ac:layout-cell" || macro(node, "column"),
  ).filter((node) => {
    if (
      storage.slice(node.startIndex!, openEnd(node)).trimEnd().endsWith("/>")
    ) {
      warnings.add(
        "空的自闭合布局区域仅供阅读，添加内容请选其他正文区域或整页更新。",
      );
      return false;
    }
    return true;
  });
  const containers: { node: Node; start: number; end: number }[] =
    regionNodes.map((node) => {
      const container = macro(node)
        ? elements(children(node)).find(
            (child) => child.name === "ac:rich-text-body",
          ) || node
        : node;
      const start = openEnd(container);
      const end = storage.lastIndexOf("</", container.endIndex!);
      if (end < start) {
        throw new Error("页面区域边界无效");
      }
      return { node: container, start, end };
    });
  if (!containers.length) {
    containers.push({ node: doc, start: 0, end: storage.length });
  }
  const isLossy = (nodes: Node[]): boolean =>
    nodes.some((node) => lossyNodes.has(node) || isLossy(children(node)));
  const regions: Region[] = containers.map((item, index) => ({
    id: `r${index + 1}`,
    label: `区域 ${index + 1}`,
    start: item.start,
    end: item.end,
    wiki: children(item.node)
      .map((node) => wiki(node))
      .join("")
      .trim(),
    lossy: isLossy(children(item.node)),
  }));
  const sections: Section[] = [];
  for (const [index, container] of containers.entries()) {
    const directHeadings = elements(children(container.node)).filter((node) =>
      /^h[1-6]$/.test(node.name),
    );
    const ancestors: { level: number; title: string }[] = [];
    for (const [headingIndex, heading] of directHeadings.entries()) {
      const level = Number(heading.name[1]);
      const title = textOf(heading).trim();
      while (ancestors.length && ancestors.at(-1)!.level >= level) {
        ancestors.pop();
      }
      ancestors.push({ level, title });
      const next = directHeadings
        .slice(headingIndex + 1)
        .find((node) => Number(node.name[1]) <= level);
      const bodyStart = heading.endIndex! + 1;
      const end = next?.startIndex ?? container.end;
      const selected = children(container.node).filter(
        (node) =>
          node.startIndex !== null &&
          node.startIndex! >= bodyStart &&
          node.startIndex! < end,
      );
      sections.push({
        id: `r${index + 1}-s${headingIndex + 1}`,
        regionId: `r${index + 1}`,
        title,
        level,
        path: ancestors.map((item) => item.title).join(" / "),
        start: heading.startIndex!,
        bodyStart,
        end,
        wiki: selected
          .map((node) => wiki(node))
          .join("")
          .trim(),
        lossy: isLossy(selected),
      });
    }
  }
  const substantial = regions.filter((region) =>
    region.wiki.replace(/\{toc[^}]*\}/g, "").trim(),
  );
  const defaultRegionId =
    substantial.length === 1
      ? substantial[0].id
      : regions.length === 1
        ? regions[0].id
        : undefined;
  return {
    wiki: contentWiki,
    html: contentHtml,
    warnings: [...warnings],
    lossy: lossyNodes.size > 0,
    sections,
    regions,
    defaultRegionId,
  };
}

export function withLayout(
  storage: string,
  layout: "right-toc" | "plain",
): string {
  if (layout === "plain") {
    return storage;
  }
  const doc = parseDocument(storage, { xmlMode: true });
  if (
    descendants(
      doc.children,
      (node) =>
        node.name === "ac:layout" ||
        macro(node, "section") ||
        macro(node, "column"),
    ).length
  ) {
    throw new Error(
      "正文已包含布局；请选择 plain 保留完整 wiki 布局，或仅提供正文并使用 right-toc",
    );
  }
  return `<ac:layout><ac:layout-section ac:type="two_right_sidebar"><ac:layout-cell>${storage}</ac:layout-cell><ac:layout-cell><ac:structured-macro ac:name="toc" ac:schema-version="1"><ac:parameter ac:name="minLevel">1</ac:parameter><ac:parameter ac:name="maxLevel">4</ac:parameter></ac:structured-macro></ac:layout-cell></ac:layout-section></ac:layout>`;
}

export function editStorage(
  storage: string,
  replacement: string,
  mode: "append" | "replace-section" | "replace-page",
  sectionId?: string,
  regionId?: string,
): { storage: string; before: string; after: string } {
  if (mode === "replace-page") {
    return { storage: replacement, before: storage, after: replacement };
  }
  const parsed = analyzeStorage(storage);
  if (mode === "replace-section") {
    const section = parsed.sections.find((item) => item.id === sectionId);
    if (!section) {
      throw new Error(
        "请选择 read 返回的有效 sectionId；嵌套在复杂宏中的标题不支持直接局部替换",
      );
    }
    return {
      storage:
        storage.slice(0, section.bodyStart) +
        replacement +
        storage.slice(section.end),
      before: storage.slice(section.bodyStart, section.end),
      after: replacement,
    };
  }
  const region = parsed.regions.find(
    (item) => item.id === (regionId || parsed.defaultRegionId),
  );
  if (!region) {
    throw new Error("页面有多个正文区域，请从 read 返回结果中指定 regionId");
  }
  return {
    storage:
      storage.slice(0, region.end) + replacement + storage.slice(region.end),
    before: "",
    after: replacement,
  };
}
