/** Project resolution for the deterministic Jarvis query parser. */
import { jarvisProjectPhrases } from "./jarvis-bug-query.js";
import type { JarvisProjectRow } from "./jarvis-cli.js";

const MAX_AMBIGUOUS_PROJECT_MATCHES = 3;
interface ProjectResolution {
  tokens: { token: string; projects: JarvisProjectRow[] }[];
  targets: Map<number, JarvisProjectRow>;
  keyword: string | null;
}
type ProjectTokenMatch = ProjectResolution["tokens"][number];

function uniqById(projects: readonly JarvisProjectRow[]): JarvisProjectRow[] {
  const seen = new Set<number>();
  return projects.filter((project) => {
    if (seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  });
}

function containsMatch(name: string, phrase: string): boolean {
  const normalizedName = name.toLocaleLowerCase();
  const normalizedPhrase = phrase.toLocaleLowerCase();
  return normalizedName.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedName);
}

function isBroadProjectMatch(phrase: string, projects: readonly JarvisProjectRow[]): boolean {
  return (
    uniqById(projects).length > MAX_AMBIGUOUS_PROJECT_MATCHES &&
    !projects.some((project) =>
      phrase.toLocaleLowerCase().includes(project.name.toLocaleLowerCase()),
    )
  );
}

/**
 * Match the leftover text against the projects linked to my bugs before any
 * network search. A project name contained in the phrase is removed so the
 * rest can still become the title keyword.
 */
function matchKnownProjects(
  phrase: string,
  known: readonly JarvisProjectRow[],
): { projects: JarvisProjectRow[]; remainder: string } {
  const matches = known
    .filter((project) => [...project.name].length >= 2 && containsMatch(project.name, phrase))
    .sort((left, right) => right.name.length - left.name.length);
  if (matches.length === 0) return { projects: [], remainder: phrase };
  let remainder = phrase;
  for (const project of matches) {
    remainder = remainder.replace(project.name, " ");
    // The phrase may be a prefix of the project name, in which case the phrase
    // itself is consumed.
    if (remainder === phrase) remainder = "";
  }
  return { projects: matches, remainder: remainder.trim() };
}

function searchVariants(phrase: string): string[] {
  const chars = [...phrase];
  if (chars.length <= 2) return [];
  const variants: string[] = [];
  for (let length = chars.length - 1; length >= 2 && variants.length < 4; length -= 1) {
    variants.push(chars.slice(0, length).join(""));
  }
  for (let start = 1; start <= chars.length - 2 && variants.length < 6; start += 1) {
    variants.push(chars.slice(start).join(""));
  }
  return variants;
}

export async function resolveJarvisRuleProjects(
  leftover: string,
  known: readonly JarvisProjectRow[],
  omit: Set<string>,
  searchProjects: (name: string) => Promise<JarvisProjectRow[]>,
): Promise<ProjectResolution> {
  const tokens: ProjectTokenMatch[] = [];
  const targets = new Map<number, JarvisProjectRow>();
  const remainders: string[] = [];
  let searchBudget = 6;

  for (const phrase of jarvisProjectPhrases(leftover)) {
    if (omit.has(`project:${phrase}`)) continue;
    const knownMatch = matchKnownProjects(phrase, known);
    const direct = await searchProjects(phrase);
    if (isBroadProjectMatch(phrase, [...knownMatch.projects, ...direct])) {
      remainders.push(phrase);
      continue;
    }
    if (knownMatch.projects.length > 0) {
      const matched = uniqById(knownMatch.projects);
      tokens.push({ token: phrase, projects: matched });
      for (const project of matched) targets.set(project.id, project);
      if (knownMatch.remainder) remainders.push(knownMatch.remainder);
      continue;
    }
    let matched: JarvisProjectRow[] = [];
    let consumed = phrase;
    if (direct.length > 0) {
      matched = direct;
    } else if (searchBudget > 0) {
      for (const variant of searchVariants(phrase).filter(
        (value) => jarvisProjectPhrases(value).length > 0,
      )) {
        if (searchBudget <= 0) break;
        searchBudget -= 1;
        const result = await searchProjects(variant);
        if (result.length > 0) {
          if (isBroadProjectMatch(variant, result)) break;
          if (omit.has(`project:${variant}`)) break;
          matched = result;
          consumed = variant;
          const index = phrase.indexOf(variant);
          const rest = `${phrase.slice(0, index)} ${phrase
            .slice(index + variant.length)
            .trim()}`.trim();
          if (rest) remainders.push(rest);
          break;
        }
      }
    }
    if (matched.length > 0) {
      const unique = uniqById(matched);
      tokens.push({ token: consumed, projects: unique });
      for (const project of unique) targets.set(project.id, project);
    } else {
      remainders.push(phrase);
    }
  }

  if (targets.size === 0) {
    for (const project of known) {
      if (omit.has(`project:${project.name}`)) continue;
      targets.set(project.id, project);
    }
  }
  const keyword = remainders.join(" ").trim() || null;
  return { tokens, targets, keyword };
}
