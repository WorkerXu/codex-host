/** Parses MCPHub's own environment file; values never leave the Host. */
export function parseHubEnvironment(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = /^(?:export\s+)?([A-Z_][A-Z_0-9]*)\s*=\s*(.*)$/u.exec(line.trim());
    if (!match?.[1] || match[2] === undefined) continue;
    const value = match[2].trim();
    result[match[1]] = /^(["']).*\1$/u.test(value) ? value.slice(1, -1) : value;
  }
  return result;
}
