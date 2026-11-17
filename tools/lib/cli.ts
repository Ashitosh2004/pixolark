/**
 * Tiny CLI + JSON helpers for the Pixolark owner tools.
 * No dependencies, no database — files in, files out.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface Args {
  _: string[];
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { _: [], flags: new Map() };
  let current: string | null = null;
  for (const raw of argv) {
    if (raw.startsWith("--")) {
      current = raw.slice(2);
      if (!args.flags.has(current)) args.flags.set(current, []);
      // Allow "--flag value" as well as "--flag=value"
      if (current.includes("=")) {
        const [name, ...rest] = current.split("=");
        args.flags.delete(current);
        args.flags.set(name!, rest.join("=") === "" ? [] : [rest.join("=")]);
        current = name!;
      }
      continue;
    }
    if (current) args.flags.get(current)!.push(raw);
    else args._.push(raw);
  }
  return args;
}

export function flag(a: Args, name: string): string | undefined {
  return a.flags.get(name)?.[0];
}

export function flags(a: Args, name: string): string[] {
  return a.flags.get(name) ?? [];
}

export function die(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

export async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, "utf8")) as T;
}

export async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function writeJson(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Split "A,B C" into ["A","B","C"], dropping empties. */
export function splitList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(/[,\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}
