/**
 * 训练模式下的自动学习：有候选就直接写进技能文件，不问。
 * 与 skill-append.mjs 同口径：查重、上限 12 条。
 */
import fs from "node:fs";
import path from "node:path";

export function learningDir() {
  return path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".dsh", "continuity");
}

export function trainingMode() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(learningDir(), "training.json"), "utf8"));
    return Number(raw?.mode) === 1 ? 1 : 0;
  } catch {
    return 0;
  }
}

function sectionBounds(lines) {
  const start = lines.findIndex((l) => l.startsWith("## 失败分支"));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (lines[i].startsWith("## ")) { end = i; break; }
  return { start, end };
}

function tokens(text) {
  return new Set(String(text).toLowerCase().split(/[^a-z0-9\u4e00-\u9fa5_]+/).filter((x) => x.length >= 2));
}

function covered(sig, line) {
  const a = tokens(sig), b = tokens(line);
  if (a.size === 0) return false;
  let hit = 0;
  for (const t of a) if (b.has(t)) hit++;
  if (hit / a.size >= 0.6) return true;
  const norm = (s) => s.replace(/\s+/g, " ").slice(0, 24);
  return line.includes(norm(sig));
}

/**
 * 自动写入一条教训。
 * @returns {{ok:boolean, action:'appended'|'duplicate'|'cap'|'error', message:string}}
 */
export function autoLearn({ sig, count, skillFile }) {
  try {
    const file = skillFile ?? path.join(learningDir(), "skills", "change-loop.md");
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split(/\r?\n/);
    const bounds = sectionBounds(lines);
    if (bounds === null) return { ok: false, action: "error", message: "失败分支段不存在" };

    const body = lines.slice(bounds.start + 1, bounds.end);
    const bullets = body.filter((l) => l.trim().startsWith("- "));
    for (const b of bullets) if (covered(sig, b)) return { ok: false, action: "duplicate", message: b.trim().slice(0, 80) };
    if (bullets.length >= 12) return { ok: false, action: "cap", message: `已满 ${bullets.length}/12，需合并` };

    const bullet = `- **${sig}**：重复出现 ${count} 次，自动记入（训练模式）。`;
    let insertAt = bounds.end;
    for (let i = bounds.end - 1; i > bounds.start; i--) {
      if (lines[i].trim() !== "") { insertAt = i + 1; break; }
    }
    lines.splice(insertAt, 0, bullet);
    fs.writeFileSync(file, lines.join("\n"), "utf8");

    const log = path.join(learningDir(), "learning", "auto-log.jsonl");
    fs.mkdirSync(path.dirname(log), { recursive: true });
    fs.appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), sig, count, action: "appended" }) + "\n", "utf8");
    return { ok: true, action: "appended", message: bullet };
  } catch (error) {
    return { ok: false, action: "error", message: String(error?.message ?? error) };
  }
}
