import { createHash } from "node:crypto";
import type { MeetingDocument, MeetingSection } from "./types";

export const maxPackBytes = 2 * 1024 * 1024;
export function validateDocuments(value: unknown): MeetingDocument[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error("Выберите от 1 до 20 MD-файлов.");
  }
  const names = new Set<string>();
  let bytes = 0;
  return value.map((item) => {
    if (!item || typeof item.name !== "string" || typeof item.text !== "string" ||
      !/^[^/\\\x00-\x1f]{1,180}\.md$/i.test(item.name) || !item.text.trim() ||
      item.text.includes("\0") || names.has(item.name.toLowerCase())) {
      throw new Error("Нужны непустые MD-файлы с разными именами.");
    }
    names.add(item.name.toLowerCase());
    bytes += Buffer.byteLength(item.text);
    if (bytes > maxPackBytes) throw new Error("Набор превышает 2 MB.");
    return { name: item.name, text: item.text };
  });
}

// Preserve explicit metadata, never infer that a paragraph is a confirmed fact.
function fields(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  const keys: Record<string, string> = {
    project: "project", проект: "project", type: "type", тип: "type",
    status: "status", статус: "status", as_of: "as_of", "актуально на": "as_of",
    "срез материалов": "as_of", source: "source", источник: "source", основание: "source",
    participants: "participants", участники: "participants", aliases: "aliases",
    "другие варианты имени": "aliases", тема: "topic", topic: "topic"
  };
  for (const line of text.split("\n")) {
    const match = line.replace(/\*\*/g, "").replace(/^[-*]\s+/, "").match(/^([^:]{1,45}):\s*(.+)$/);
    if (match && keys[match[1].trim().toLowerCase()]) {
      result[keys[match[1].trim().toLowerCase()]] = match[2].trim().slice(0, 240);
    }
  }
  return result;
}

export function prepareSections(documents: MeetingDocument[], packId: string, createdAt: string): MeetingSection[] {
  const result: MeetingSection[] = [];
  for (const document of documents) {
    const text = document.text.replace(/\r\n/g, "\n");
    const blocks: { heading: string; text: string }[] = [];
    let headings: string[] = [];
    let body: string[] = [];
    let fenced = false;
    const flush = () => {
      if (body.join("\n").trim()) blocks.push({ heading: headings.join(" / ") || document.name, text: body.join("\n").trim() });
      body = [];
    };
    for (const line of text.split("\n")) {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      const heading = !fenced && line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        flush(); headings = headings.slice(0, heading[1].length - 1); headings[heading[1].length - 1] = heading[2];
      } else body.push(line);
    }
    flush();
    const globalFields = blocks[0] && !blocks[0].heading.includes(" / ") ? fields(blocks[0].text) : {};
    for (const block of blocks) {
      // Keep a whole semantic section; long sections are bounded with overlap.
      for (let offset = 0; offset < block.text.length; offset += 5000) {
        const id = `s${result.length + 1}`;
        const metadata = { ...globalFields, ...fields(block.text), pack_id: packId,
          prepared_at: createdAt, source_hash: createHash("sha256").update(document.text).digest("hex") };
        result.push({ id, filename: document.name, heading: block.heading,
          text: block.text.slice(offset, offset + 5500), metadata });
      }
    }
  }
  if (!result.length || result.length > 160) throw new Error("Набор должен содержать от 1 до 160 смысловых разделов.");
  return result;
}
