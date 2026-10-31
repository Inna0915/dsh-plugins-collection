/** Normalize only the returned value; original storage snapshots and writes are untouched. */
export function jsonOutput(value: unknown): any {
  let repaired = false;
  function visit(item: any, arrayItem = false): any {
    if (item === undefined) {
      return arrayItem ? null : undefined;
    }
    if (item === null || typeof item === "boolean") {
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) {
        repaired = true;
        return null;
      }
      return Object.is(item, -0) ? 0 : item;
    }
    if (typeof item === "string") {
      return item.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        () => {
          repaired = true;
          return "\uFFFD";
        },
      );
    }
    if (Array.isArray(item)) {
      return item.map((child) => visit(child, true));
    }
    if (
      typeof item === "object" &&
      (Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null)
    ) {
      return Object.fromEntries(
        Object.entries(item)
          .filter(([, child]) => child !== undefined)
          .map(([key, child]) => [key, visit(child)]),
      );
    }
    throw new Error("工具返回了无法序列化的值");
  }
  const result = visit(value);
  if (
    repaired &&
    result &&
    !Array.isArray(result) &&
    typeof result === "object"
  ) {
    result.warnings = [
      ...(result.warnings || []),
      "返回表示中的无效 Unicode 或非有限数值已规范化；原始 storage 未修改。",
    ];
  }
  return result;
}
export function outputBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(jsonOutput(value)), "utf8");
}
export function characterBoundary(text: string, offset: number): number {
  const at = Math.min(text.length, Math.max(0, offset));
  return at > 0 &&
    at < text.length &&
    /[\uD800-\uDBFF]/.test(text[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[at])
    ? at - 1
    : at;
}
/** Select a prefix whose complete serialized result fits the requested UTF-8 byte budget. */
export function fitText(
  text: string,
  build: (part: string) => any,
  maxBytes: number,
): any {
  let low = 0;
  let high = text.length;
  if (outputBytes(build("")) > maxBytes) {
    throw new Error("元数据超过输出预算，请提高 maxBytes");
  }
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (
      outputBytes(build(text.slice(0, characterBoundary(text, mid)))) <=
      maxBytes
    ) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return jsonOutput(build(text.slice(0, characterBoundary(text, low))));
}
export function fitRows(
  rows: any[],
  build: (selected: any[]) => any,
  maxBytes: number,
): any {
  if (outputBytes(build([])) > maxBytes) {
    throw new Error("元数据超过输出预算，请提高 maxBytes");
  }
  const selected: any[] = [];
  for (const row of rows) {
    if (outputBytes(build([...selected, row])) > maxBytes) {
      break;
    }
    selected.push(row);
  }
  if (rows.length && !selected.length) {
    throw new Error("单条结果超过输出预算，请提高 maxBytes 或缩小上下文");
  }
  return jsonOutput(build(selected));
}
