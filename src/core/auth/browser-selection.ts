/**
 * Explicit browser / profile selection for `--live-reads` / `--write` auth.
 *
 * By default the token extractor searches every supported browser in a fixed
 * order and the first working session wins. On a machine where two people are
 * logged into Copilot in two different browsers that picks the same account
 * every time, whoever happens to come first. `--browser` / `--browser-profile`
 * (or `COPILOT_BROWSER` / `COPILOT_BROWSER_PROFILE`) pin the search to exactly
 * one browser, and optionally one profile of it, with no fallback.
 *
 * This module only resolves and validates the selection. Where each browser
 * keeps its data, and how a profile name maps to a directory, live in
 * `browser-token.ts`.
 */

/** Canonical id of every browser the extractor knows about. */
export type BrowserId =
  | 'chrome'
  | 'arc'
  | 'edge'
  | 'brave'
  | 'vivaldi'
  | 'chromium'
  | 'opera'
  | 'opera-gx'
  | 'safari'
  | 'firefox';

/** Canonical ids, in the default search order. */
export const BROWSER_IDS: readonly BrowserId[] = [
  'chrome',
  'arc',
  'edge',
  'brave',
  'vivaldi',
  'chromium',
  'opera',
  'opera-gx',
  'safari',
  'firefox',
];

/** Display name for each id — the same names `BrowserConfig.name` uses. */
export const BROWSER_DISPLAY_NAMES: Readonly<Record<BrowserId, string>> = {
  chrome: 'Chrome',
  arc: 'Arc',
  edge: 'Microsoft Edge',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  chromium: 'Chromium',
  opera: 'Opera',
  'opera-gx': 'Opera GX',
  safari: 'Safari',
  firefox: 'Firefox',
};

/**
 * Aliases accepted on top of the canonical ids, after normalization
 * (lower-cased, spaces and underscores folded to `-`).
 */
const ALIASES: Readonly<Record<string, BrowserId>> = {
  'microsoft-edge': 'edge',
  operagx: 'opera-gx',
};

/** Browsers that exist only on macOS. */
const MACOS_ONLY: ReadonlySet<BrowserId> = new Set<BrowserId>(['arc', 'safari', 'opera-gx']);

/** Browsers with no notion of a selectable profile directory. */
const NO_PROFILES: ReadonlySet<BrowserId> = new Set<BrowserId>(['safari']);

/** A resolved, validated selection. */
export interface BrowserSelection {
  browser: BrowserId;
  /** Profile directory name or display name; undefined = every profile. */
  profile?: string;
}

/** A selection that cannot be honoured. The CLI turns this into exit 1. */
export class BrowserSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserSelectionError';
  }
}

/** Every name `resolveBrowserName` accepts, for error messages and --help. */
export function validBrowserNames(): string[] {
  return [...BROWSER_IDS, ...Object.keys(ALIASES)];
}

/**
 * Resolve a user-supplied browser name to its canonical id.
 *
 * @throws BrowserSelectionError for an unknown name, listing the valid ones.
 */
export function resolveBrowserName(name: string): BrowserId {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
  if ((BROWSER_IDS as readonly string[]).includes(normalized)) return normalized as BrowserId;
  const alias = ALIASES[normalized];
  if (alias) return alias;
  throw new BrowserSelectionError(
    `Unknown browser "${name}". Valid names: ${validBrowserNames().join(', ')}.`
  );
}

/** True when the extractor has storage locations for `browser` on `platform`. */
export function isBrowserSupportedOn(browser: BrowserId, platform: NodeJS.Platform): boolean {
  return platform !== 'linux' || !MACOS_ONLY.has(browser);
}

/** Raw inputs, before precedence and validation. */
export interface BrowserSelectionInput {
  /** `--browser` value, if the flag was given. */
  browserFlag?: string;
  /** `--browser-profile` value, if the flag was given. */
  profileFlag?: string;
  /** Environment to read `COPILOT_BROWSER` / `COPILOT_BROWSER_PROFILE` from. */
  env?: Record<string, string | undefined>;
  /** Platform to validate against; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/** Treat an empty or whitespace-only value as "not given". */
function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Combine flags and environment into one validated selection.
 *
 * Each flag wins over its own environment variable. Returns undefined when no
 * browser was asked for — the default search over every browser.
 *
 * @throws BrowserSelectionError for an unknown browser, a browser this platform
 *   does not have, a profile for a browser without profiles, or a profile with
 *   no browser.
 */
export function parseBrowserSelection(input: BrowserSelectionInput): BrowserSelection | undefined {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const browserName = present(input.browserFlag) ?? present(env.COPILOT_BROWSER);
  const profile = present(input.profileFlag) ?? present(env.COPILOT_BROWSER_PROFILE);

  if (!browserName) {
    if (profile) {
      throw new BrowserSelectionError(
        '--browser-profile (COPILOT_BROWSER_PROFILE) requires --browser (COPILOT_BROWSER): ' +
          'a profile name only means something within one browser.'
      );
    }
    return undefined;
  }

  const browser = resolveBrowserName(browserName);
  const display = BROWSER_DISPLAY_NAMES[browser];
  if (!isBrowserSupportedOn(browser, platform)) {
    throw new BrowserSelectionError(`${display} is not supported on this platform (${platform}).`);
  }
  if (profile && NO_PROFILES.has(browser)) {
    throw new BrowserSelectionError(
      `${display} has no selectable profiles; drop --browser-profile (COPILOT_BROWSER_PROFILE).`
    );
  }
  return profile ? { browser, profile } : { browser };
}

/** Human-readable label, e.g. `Brave (profile "Default")`. */
export function describeBrowserSelection(selection: BrowserSelection): string {
  const display = BROWSER_DISPLAY_NAMES[selection.browser];
  return selection.profile ? `${display} (profile "${selection.profile}")` : display;
}
