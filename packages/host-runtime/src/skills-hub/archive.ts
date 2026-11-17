import { gzipSync, gunzipSync } from "node:zlib";
import { fail, MAX_SKILL_BYTES, type SkillFile } from "./files.js";

/** A bounded ustar subset: regular files only, no links, devices, extensions or paths outside the skill. */
export function packSkill(files: SkillFile[]): string {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const slash = file.path.lastIndexOf("/");
    const name = Buffer.byteLength(file.path) <= 100 ? file.path : file.path.slice(slash + 1);
    const prefix = name === file.path ? "" : file.path.slice(0, slash);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155)
      fail("archive_path_too_long");
    header.write(name, 0, 100, "utf8");
    header.write(prefix, 345, 155, "utf8");
    const octal = (offset: number, length: number, value: number) =>
      header.write(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length, "ascii");
    octal(100, 8, file.executable ? 0o755 : 0o644);
    octal(108, 8, 0);
    octal(116, 8, 0);
    octal(124, 12, file.data.length);
    octal(136, 12, Math.floor(file.modified / 1000));
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257, 6);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    chunks.push(header, file.data, Buffer.alloc((512 - (file.data.length % 512)) % 512));
  }
  chunks.push(Buffer.alloc(1024));
  const compressed = gzipSync(Buffer.concat(chunks));
  if (compressed.length > 68 * 1024 * 1024) fail("skill_too_large");
  return compressed.toString("base64");
}
export function unpackSkill(data: string): SkillFile[] {
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(data) || data.length > 96 * 1024 * 1024)
    fail("invalid_archive");
  const buffer = gunzipSync(Buffer.from(data, "base64"), {
    maxOutputLength: MAX_SKILL_BYTES + 8192 * 1024 + 1024,
  });
  const files: SkillFile[] = [],
    names = new Set<string>();
  let bytes = 0;
  for (let offset = 0; offset + 512 <= buffer.length;) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/su, "");
    const octal = (start: number, length: number): number => {
      const value = text(start, length).trim();
      if (!/^[0-7]+$/u.test(value)) fail("invalid_archive");
      return parseInt(value, 8);
    };
    const expected = octal(148, 8);
    const checksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (checksum !== expected || text(257, 6) !== "ustar" || !["0", ""].includes(text(156, 1)))
      fail("invalid_archive");
    const prefix = text(345, 155),
      name = text(0, 100);
    const key = prefix ? `${prefix}/${name}` : name;
    if (
      !key ||
      key.includes("\\") ||
      key
        .split("/")
        .some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            [".git", ".svn", ".hg", ".DS_Store"].includes(part),
        ) ||
      key.startsWith("/") ||
      key.includes(":") ||
      names.has(key)
    )
      fail("invalid_archive_path");
    names.add(key);
    const size = octal(124, 12);
    bytes += size;
    if (bytes > MAX_SKILL_BYTES || files.length >= 8192 || offset + 512 + size > buffer.length)
      fail("skill_too_large");
    files.push({
      path: key,
      data: Buffer.from(buffer.subarray(offset + 512, offset + 512 + size)),
      executable: (octal(100, 8) & 0o111) !== 0,
      modified: octal(136, 12) * 1000,
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!names.has("SKILL.md")) fail("missing_skill_md");
  for (const name of names)
    for (const other of names) if (other.startsWith(`${name}/`)) fail("invalid_archive_path");
  return files;
}
