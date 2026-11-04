import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { MAX_FILE_BYTES, type Indent } from "../../shared/types";

export interface KeyAlignmentResult {
  success: boolean;
  left: string;
  right: string;
  alignedObjects: number;
  error?: string;
}

const MAX_DEPTH = 512;
const MAX_CHARACTERS = MAX_FILE_BYTES * 4;

function parseDocument(text: string): Node {
  if (text.length > MAX_CHARACTERS)
    throw new Error("对比内容过大，请拆分文件后重试。");
  let depth = 0;
  let quoted = false;
  for (let offset = 0; offset < text.length; offset++) {
    const character = text[offset];
    if (quoted) {
      if (character === "\\") offset++;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > MAX_DEPTH)
        throw new Error("JSON 嵌套超过 512 层，请缩小对比范围后重试。");
    } else if (character === "}" || character === "]") depth--;
  }
  const errors: ParseError[] = [];
  const root = parseTree(text, errors, {
    disallowComments: true,
    allowTrailingComma: false,
    allowEmptyContent: false,
  });
  if (!root || errors.length)
    throw new Error("请先将两侧内容格式化为有效 JSON。");
  return root;
}

type Entry = { node: Node; reference?: Node };
type Task = Entry & { depth: number };

function orderedProperties(node: Node, reference?: Node): Entry[] {
  const properties = node.children ?? [];
  if (reference?.type !== "object")
    return properties.map((property) => ({ node: property }));
  const grouped = new Map<string, { nodes: Node[]; cursor: number }>();
  for (const property of properties) {
    const key = property.children![0].value as string;
    const group = grouped.get(key);
    if (group) group.nodes.push(property);
    else grouped.set(key, { nodes: [property], cursor: 0 });
  }
  const ordered: Entry[] = [];
  const matched = new Set<Node>();
  for (const property of reference.children ?? []) {
    const group = grouped.get(property.children![0].value as string);
    if (!group || group.cursor === group.nodes.length) continue;
    const node = group.nodes[group.cursor++];
    matched.add(node);
    ordered.push({ node, reference: property });
  }
  for (const property of properties) {
    if (!matched.has(property)) ordered.push({ node: property });
  }
  return ordered;
}

export function alignJsonKeys(
  left: string,
  right: string,
  indent: Indent,
): KeyAlignmentResult {
  const result: KeyAlignmentResult = {
    success: false,
    left,
    right,
    alignedObjects: 0,
  };
  try {
    const reference = parseDocument(left);
    const document = parseDocument(right);
    const unit = indent === "tab" ? "\t" : " ".repeat(Number(indent));
    const indentation = [""];
    const padding = (depth: number) => {
      while (indentation.length <= depth)
        indentation.push(indentation[indentation.length - 1] + unit);
      return indentation[depth];
    };
    const chunks: string[] = [];
    let outputLength = 0;
    const append = (text: string) => {
      outputLength += text.length;
      if (outputLength > MAX_CHARACTERS)
        throw new Error("对比内容过大，请拆分文件后重试。");
      chunks.push(text);
    };
    const tasks: (Task | string)[] = [{ node: document, reference, depth: 0 }];
    while (tasks.length) {
      const task = tasks.pop()!;
      if (typeof task === "string") {
        append(task);
        continue;
      }
      const { node, reference, depth } = task;
      if (node.type === "property") {
        const [key, value] = node.children!;
        append(right.slice(key.offset, key.offset + key.length) + ": ");
        tasks.push({ node: value, reference: reference?.children?.[1], depth });
      } else if (node.type === "object" || node.type === "array") {
        const object = node.type === "object";
        const entries = object
          ? orderedProperties(node, reference)
          : (node.children ?? []).map((child, index) => ({
              node: child,
              reference:
                reference?.type === "array"
                  ? reference.children?.[index]
                  : undefined,
            }));
        if (
          object &&
          entries.some((entry, index) => entry.node !== node.children?.[index])
        )
          result.alignedObjects++;
        const open = object ? "{" : "[";
        const close = object ? "}" : "]";
        if (!entries.length) {
          append(open + close);
          continue;
        }
        append(open + "\n");
        tasks.push("\n" + padding(depth) + close);
        for (let index = entries.length - 1; index >= 0; index--) {
          if (index < entries.length - 1) tasks.push(",\n");
          tasks.push({ ...entries[index], depth: depth + 1 });
          tasks.push(padding(depth + 1));
        }
      } else append(right.slice(node.offset, node.offset + node.length));
    }
    result.success = true;
    result.right = chunks.join("");
    return result;
  } catch (error) {
    return {
      ...result,
      alignedObjects: 0,
      error:
        error instanceof Error ? error.message : "无法对齐 JSON Key 顺序。",
    };
  }
}
