/**
 * Explicit browser / profile selection (`--browser`, `--browser-profile`,
 * `COPILOT_BROWSER`, `COPILOT_BROWSER_PROFILE`) and the platform tables the
 * extractor searches.
 *
 * The motivating case: two people logged into Copilot in two browsers on one
 * machine. Without a selection the fixed search order picks the same account
 * every run; with one, exactly the selected browser/profile is read and a
 * token planted anywhere else must stay invisible.
 *
 * Every browser directory here lives under a throwaway fake home. Tokens are
 * runtime-generated placeholders, never real values.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import {
  BROWSER_IDS,
  BrowserSelectionError,
  parseBrowserSelection,
  resolveBrowserName,
  validBrowserNames,
} from '../../../src/core/auth/browser-selection.js';
import {
  BROWSER_CONFIGS,
  extractRefreshToken,
  extractRefreshTokenCandidates,
  getBrowserConfigs,
  getChromiumProfileStoragePaths,
  noCopilotSessionError,
  type BrowserConfig,
} from '../../../src/core/auth/browser-token.js';
import { FirebaseAuth } from '../../../src/core/auth/firebase-auth.js';

const IDB = 'IndexedDB/https_app.copilot.money_0.indexeddb.leveldb';
const LS = 'Local Storage/leveldb';

/** An obviously fake refresh token, distinct per `tag`. */
function fakeToken(tag: string): string {
  return 'AMf-FAKE' + tag.replace(/[^A-Za-z0-9]/g, '') + 'x'.repeat(120);
}

/** Plant a fake token in a Chromium profile's Copilot IndexedDB dir. */
function plantChromium(userDataDir: string, profileDir: string, token: string): void {
  const dir = join(userDataDir, profileDir, IDB);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '000003.log'), `prefix ${token} suffix`);
}

/** Plant a fake token in a Firefox profile's Copilot origin dir. */
function plantFirefox(profilesDir: string, profileDir: string, token: string): void {
  const dir = join(profilesDir, profileDir, 'storage/default/https+++app.copilot.money/idb');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '1234.sqlite'), `prefix ${token} suffix`);
}

function writeLocalState(userDataDir: string, infoCache: Record<string, { name: string }>): void {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(
    join(userDataDir, 'Local State'),
    JSON.stringify({ profile: { info_cache: infoCache }, unrelated: { key: 'ignored' } })
  );
}

describe('resolveBrowserName', () => {
  test('accepts every canonical id, case-insensitively', () => {
    for (const id of BROWSER_IDS) {
      expect(resolveBrowserName(id)).toBe(id);
      expect(resolveBrowserName(id.toUpperCase())).toBe(id);
    }
  });

  test('accepts the documented aliases', () => {
    expect(resolveBrowserName('microsoft-edge')).toBe('edge');
    expect(resolveBrowserName('Microsoft Edge')).toBe('edge');
    expect(resolveBrowserName('OperaGX')).toBe('opera-gx');
    expect(resolveBrowserName('opera_gx')).toBe('opera-gx');
    expect(resolveBrowserName(' Brave ')).toBe('brave');
  });

  test('rejects an unknown name, listing every valid one', () => {
    expect(() => resolveBrowserName('netscape')).toThrow(BrowserSelectionError);
    try {
      resolveBrowserName('netscape');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Unknown browser "netscape"');
      for (const name of validBrowserNames()) expect(message).toContain(name);
    }
  });
});

describe('parseBrowserSelection', () => {
  const mac = 'darwin' as const;

  test('nothing given → undefined (the default search)', () => {
    expect(parseBrowserSelection({ env: {}, platform: mac })).toBeUndefined();
  });

  test('reads COPILOT_BROWSER / COPILOT_BROWSER_PROFILE', () => {
    expect(
      parseBrowserSelection({
        env: { COPILOT_BROWSER: 'Brave', COPILOT_BROWSER_PROFILE: 'Default' },
        platform: mac,
      })
    ).toEqual({ browser: 'brave', profile: 'Default' });
  });

  test('each flag wins over its own environment variable', () => {
    expect(
      parseBrowserSelection({
        browserFlag: 'chrome',
        profileFlag: 'Profile 2',
        env: { COPILOT_BROWSER: 'brave', COPILOT_BROWSER_PROFILE: 'Default' },
        platform: mac,
      })
    ).toEqual({ browser: 'chrome', profile: 'Profile 2' });
    // Flag for the browser, env for the profile.
    expect(
      parseBrowserSelection({
        browserFlag: 'chrome',
        env: { COPILOT_BROWSER: 'brave', COPILOT_BROWSER_PROFILE: 'Work' },
        platform: mac,
      })
    ).toEqual({ browser: 'chrome', profile: 'Work' });
  });

  test('empty environment values count as unset', () => {
    expect(
      parseBrowserSelection({
        env: { COPILOT_BROWSER: '', COPILOT_BROWSER_PROFILE: '  ' },
        platform: mac,
      })
    ).toBeUndefined();
  });

  test('a profile without a browser is an error', () => {
    expect(() => parseBrowserSelection({ profileFlag: 'Default', env: {}, platform: mac })).toThrow(
      /--browser-profile .* requires --browser/
    );
    expect(() =>
      parseBrowserSelection({ env: { COPILOT_BROWSER_PROFILE: 'Default' }, platform: mac })
    ).toThrow(BrowserSelectionError);
  });

  test('an unknown browser is an error, from the flag or the environment', () => {
    expect(() => parseBrowserSelection({ browserFlag: 'lynx', env: {}, platform: mac })).toThrow(
      /Unknown browser "lynx"/
    );
    expect(() =>
      parseBrowserSelection({ env: { COPILOT_BROWSER: 'lynx' }, platform: mac })
    ).toThrow(/Unknown browser "lynx"/);
  });

  test('macOS-only browsers are refused on Linux', () => {
    for (const name of ['safari', 'arc', 'opera-gx']) {
      expect(() =>
        parseBrowserSelection({ browserFlag: name, env: {}, platform: 'linux' })
      ).toThrow(/not supported on this platform \(linux\)/);
      expect(parseBrowserSelection({ browserFlag: name, env: {}, platform: mac })).toBeDefined();
    }
  });

  test('Safari takes no profile', () => {
    expect(() =>
      parseBrowserSelection({ browserFlag: 'safari', profileFlag: 'x', env: {}, platform: mac })
    ).toThrow(/Safari has no selectable profiles/);
  });
});

describe('getBrowserConfigs', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-select-home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test('macOS: same ten browsers, same order, same paths as before', () => {
    const configs = getBrowserConfigs({ platform: 'darwin', home });
    const appSupport = join(home, 'Library/Application Support');
    const profileless = (dir: string): string[] => [
      join(dir, 'Default', IDB),
      join(dir, 'Default', LS),
    ];
    const opera = (dir: string): string[] => [join(dir, IDB), join(dir, LS), ...profileless(dir)];
    expect(configs).toEqual([
      { name: 'Chrome', type: 'chromium', paths: profileless(join(appSupport, 'Google/Chrome')) },
      { name: 'Arc', type: 'chromium', paths: profileless(join(appSupport, 'Arc/User Data')) },
      {
        name: 'Microsoft Edge',
        type: 'chromium',
        paths: profileless(join(appSupport, 'Microsoft Edge')),
      },
      {
        name: 'Brave',
        type: 'chromium',
        paths: profileless(join(appSupport, 'BraveSoftware/Brave-Browser')),
      },
      { name: 'Vivaldi', type: 'chromium', paths: profileless(join(appSupport, 'Vivaldi')) },
      { name: 'Chromium', type: 'chromium', paths: profileless(join(appSupport, 'Chromium')) },
      {
        name: 'Opera',
        type: 'chromium',
        paths: opera(join(appSupport, 'com.operasoftware.Opera')),
      },
      {
        name: 'Opera GX',
        type: 'chromium',
        paths: opera(join(appSupport, 'com.operasoftware.OperaGX')),
      },
      {
        name: 'Safari',
        type: 'safari',
        paths: [
          join(home, 'Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteData/Default'),
          join(home, 'Library/Safari/Databases'),
        ],
      },
      { name: 'Firefox', type: 'firefox', paths: [join(appSupport, 'Firefox/Profiles')] },
    ]);
  });

  test('BROWSER_CONFIGS is still the macOS table for the real home', () => {
    expect(BROWSER_CONFIGS.map((b) => b.name)).toEqual([
      'Chrome',
      'Arc',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      'Opera',
      'Opera GX',
      'Safari',
      'Firefox',
    ]);
    expect(BROWSER_CONFIGS[0]!.paths[0]).toBe(
      join(homedir(), 'Library/Application Support/Google/Chrome/Default', IDB)
    );
  });

  test('macOS: multi-profile discovery is unchanged', () => {
    const chrome = join(home, 'Library/Application Support/Google/Chrome');
    mkdirSync(join(chrome, 'Profile 3'), { recursive: true });
    const config = getBrowserConfigs({ platform: 'darwin', home }).find((b) => b.name === 'Chrome');
    expect(config!.paths).toEqual(getChromiumProfileStoragePaths(chrome));
    expect(config!.paths).toContain(join(chrome, 'Profile 3', IDB));
  });

  test('Linux: no Arc, Safari or Opera GX; ~/.config, snap and flatpak locations', () => {
    const configs = getBrowserConfigs({ platform: 'linux', home, env: {} });
    expect(configs.map((b) => b.name)).toEqual([
      'Chrome',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      'Opera',
      'Firefox',
    ]);
    const paths = (name: string): string[] => configs.find((b) => b.name === name)!.paths;
    const config = join(home, '.config');

    expect(paths('Chrome')).toEqual([
      join(config, 'google-chrome/Default', IDB),
      join(config, 'google-chrome/Default', LS),
      join(config, 'google-chrome-beta/Default', IDB),
      join(config, 'google-chrome-beta/Default', LS),
      join(config, 'google-chrome-unstable/Default', IDB),
      join(config, 'google-chrome-unstable/Default', LS),
    ]);
    expect(paths('Chromium')).toEqual([
      join(config, 'chromium/Default', IDB),
      join(config, 'chromium/Default', LS),
      join(home, 'snap/chromium/common/chromium/Default', IDB),
      join(home, 'snap/chromium/common/chromium/Default', LS),
    ]);
    expect(paths('Brave')).toContain(join(config, 'BraveSoftware/Brave-Browser/Default', IDB));
    expect(paths('Microsoft Edge')).toContain(join(config, 'microsoft-edge/Default', IDB));
    expect(paths('Vivaldi')).toContain(join(config, 'vivaldi/Default', IDB));
    expect(paths('Opera').slice(0, 2)).toEqual([
      join(config, 'opera', IDB),
      join(config, 'opera', LS),
    ]);
    expect(paths('Firefox')).toEqual([
      join(home, '.mozilla/firefox'),
      join(home, 'snap/firefox/common/.mozilla/firefox'),
      join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox'),
    ]);
    expect(configs.flatMap((b) => b.paths).some((p) => p.includes('Library/'))).toBe(false);
  });

  test('Linux: an absolute XDG_CONFIG_HOME replaces ~/.config; a relative one is ignored', () => {
    const xdg = join(home, 'xdg');
    const withXdg = getBrowserConfigs({ platform: 'linux', home, env: { XDG_CONFIG_HOME: xdg } });
    const chrome = withXdg.find((b) => b.name === 'Chrome')!.paths;
    expect(chrome[0]).toBe(join(xdg, 'google-chrome/Default', IDB));
    const chromium = withXdg.find((b) => b.name === 'Chromium')!.paths;
    expect(chromium[0]).toBe(join(xdg, 'chromium/Default', IDB));
    // The snap location is not under XDG_CONFIG_HOME.
    expect(chromium).toContain(join(home, 'snap/chromium/common/chromium/Default', IDB));
    // Firefox lives under ~/.mozilla regardless.
    expect(withXdg.find((b) => b.name === 'Firefox')!.paths[0]).toBe(
      join(home, '.mozilla/firefox')
    );

    const relative = getBrowserConfigs({
      platform: 'linux',
      home,
      env: { XDG_CONFIG_HOME: 'relative/dir' },
    });
    expect(relative.find((b) => b.name === 'Chrome')!.paths[0]).toBe(
      join(home, '.config/google-chrome/Default', IDB)
    );
  });

  test('Linux: the default extraction finds a token in snap Firefox and ~/.config Chrome', async () => {
    plantChromium(join(home, '.config/google-chrome'), 'Profile 1', fakeToken('chrome'));
    plantFirefox(join(home, 'snap/firefox/common/.mozilla/firefox'), 'a1.default', fakeToken('ff'));
    const { candidates, checked, selection } = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
    });
    expect(selection).toBeUndefined();
    expect(checked).toEqual([
      'Chrome',
      'Microsoft Edge',
      'Brave',
      'Vivaldi',
      'Chromium',
      'Opera',
      'Firefox',
    ]);
    expect(candidates.map((c) => [c.browser, c.token])).toEqual([
      ['Chrome', fakeToken('chrome')],
      ['Firefox', fakeToken('ff')],
    ]);
  });
});

describe('extraction with a selection', () => {
  let home: string;
  let appSupport: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'browser-select-extract-'));
    appSupport = join(home, 'Library/Application Support');
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const mac = (selection: Parameters<typeof extractRefreshTokenCandidates>[1] = {}) => ({
    platform: 'darwin' as const,
    home,
    env: {},
    ...selection,
  });

  test('--browser searches only that browser: a token in another browser stays unseen', async () => {
    // Chrome comes first in the default order, so without a selection it wins.
    plantChromium(join(appSupport, 'Google/Chrome'), 'Default', fakeToken('chrome'));
    plantChromium(join(appSupport, 'BraveSoftware/Brave-Browser'), 'Default', fakeToken('brave'));

    const unselected = await extractRefreshToken(undefined, mac());
    expect(unselected.browser).toBe('Chrome');

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'brave' } })
    );
    expect(result.checked).toEqual(['Brave']);
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('brave')]);
    expect(result.selection).toEqual({ label: 'Brave', browser: 'Brave' });
  });

  test('a selected browser with no session does not fall back to others', async () => {
    plantChromium(join(appSupport, 'Google/Chrome'), 'Default', fakeToken('chrome'));
    mkdirSync(join(appSupport, 'BraveSoftware/Brave-Browser/Default'), { recursive: true });

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'brave', profile: 'Default' } })
    );
    expect(result.candidates).toEqual([]);
    expect(result.checked).toEqual(['Brave']);
    await expect(
      extractRefreshToken(undefined, mac({ selection: { browser: 'brave', profile: 'Default' } }))
    ).rejects.toThrow(
      'No Copilot Money session found in Brave (profile "Default"). ' +
        'Please log into https://app.copilot.money in Brave (profile "Default")'
    );
  });

  test('Chromium profile by directory name, case-insensitively', async () => {
    const brave = join(appSupport, 'BraveSoftware/Brave-Browser');
    plantChromium(brave, 'Default', fakeToken('default'));
    plantChromium(brave, 'Profile 2', fakeToken('profile2'));

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'brave', profile: 'profile 2' } })
    );
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('profile2')]);
    expect(result.selection?.problem).toBeUndefined();
  });

  test('Chromium profile by its Local State display name', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('first'));
    plantChromium(chrome, 'Profile 1', fakeToken('second'));
    writeLocalState(chrome, { Default: { name: 'Person A' }, 'Profile 1': { name: 'Person B' } });

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'chrome', profile: 'person b' } })
    );
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('second')]);
    expect(result.selection?.label).toBe('Chrome (profile "person b")');
  });

  test('an unknown Chromium profile names the browser, the profile and what exists', async () => {
    const chrome = join(appSupport, 'Google/Chrome');
    plantChromium(chrome, 'Default', fakeToken('default'));

    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'chrome', profile: 'Nope' } })
    );
    expect(result.candidates).toEqual([]);
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain('No Copilot Money session found in Chrome (profile "Nope").');
    expect(message).toContain('No Chrome profile named "Nope" was found (available: Default;');
    expect(message).toContain(chrome);
    expect(message).not.toContain(fakeToken('default'));
  });

  test('a missing browser directory is reported as missing, with the paths checked', async () => {
    const result = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'vivaldi' } })
    );
    const message = noCopilotSessionError(result.checked, result.selection).message;
    expect(message).toContain('No Copilot Money session found in Vivaldi.');
    expect(message).toContain(
      `Vivaldi's data directory was not found (checked: ${join(appSupport, 'Vivaldi')}).`
    );

    const withProfile = await extractRefreshTokenCandidates(
      undefined,
      mac({ selection: { browser: 'vivaldi', profile: 'Default' } })
    );
    expect(noCopilotSessionError(withProfile.checked, withProfile.selection).message).toContain(
      "Vivaldi's data directory was not found"
    );
  });

  test('Firefox profile by directory name, by suffix, and by profiles.ini Name', async () => {
    const root = join(appSupport, 'Firefox');
    const profiles = join(root, 'Profiles');
    plantFirefox(profiles, 'abc123.default-release', fakeToken('release'));
    plantFirefox(profiles, 'def456.work', fakeToken('work'));
    writeFileSync(
      join(root, 'profiles.ini'),
      [
        '[General]',
        'StartWithLastProfile=1',
        '',
        '[Profile0]',
        'Name=Personal Stuff',
        'IsRelative=1',
        'Path=Profiles/abc123.default-release',
        '',
        '[Profile1]',
        'Name=Job',
        'IsRelative=1',
        'Path=Profiles/def456.work',
        '',
      ].join('\n')
    );

    const tokensFor = async (profile: string): Promise<string[]> =>
      (
        await extractRefreshTokenCandidates(
          undefined,
          mac({ selection: { browser: 'firefox', profile } })
        )
      ).candidates.map((c) => c.token);

    expect(await tokensFor('abc123.default-release')).toEqual([fakeToken('release')]);
    expect(await tokensFor('DEFAULT-RELEASE')).toEqual([fakeToken('release')]);
    expect(await tokensFor('work')).toEqual([fakeToken('work')]);
    expect(await tokensFor('personal stuff')).toEqual([fakeToken('release')]);
    expect(await tokensFor('Job')).toEqual([fakeToken('work')]);
    expect(await tokensFor('nobody')).toEqual([]);
  });

  test('Linux Firefox profile in the flatpak tree, selected by profiles.ini Name', async () => {
    const flatpak = join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox');
    plantFirefox(flatpak, 'zz9.default', fakeToken('flatpak'));
    writeFileSync(
      join(flatpak, 'profiles.ini'),
      '[Profile0]\nName=Everyday\nIsRelative=1\nPath=zz9.default\n'
    );
    // A token in a different browser must not be found.
    plantChromium(join(home, '.config/google-chrome'), 'Default', fakeToken('chrome'));

    const result = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'firefox', profile: 'everyday' },
    });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('flatpak')]);
    expect(result.checked).toEqual(['Firefox']);
  });

  test('Linux Chromium selection covers the snap tree', async () => {
    plantChromium(join(home, 'snap/chromium/common/chromium'), 'Default', fakeToken('snap'));
    const result = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'chromium', profile: 'default' },
    });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('snap')]);
  });

  test('selecting a browser this platform lacks finds nothing and says why', async () => {
    const result = await extractRefreshTokenCandidates(undefined, {
      platform: 'linux',
      home,
      env: {},
      selection: { browser: 'safari' },
    });
    expect(result.candidates).toEqual([]);
    expect(result.selection?.problem).toContain('not supported on this platform (linux)');
  });

  test('with overrides, a selection narrows them to the selected browser', async () => {
    const a = join(home, 'a');
    const b = join(home, 'b');
    for (const [dir, tag] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '000001.ldb'), fakeToken(tag));
    }
    const overrides: BrowserConfig[] = [
      { name: 'Chrome', paths: [a], type: 'chromium' },
      { name: 'Brave', paths: [b], type: 'chromium' },
    ];
    const result = await extractRefreshTokenCandidates(overrides, {
      selection: { browser: 'brave' },
    });
    expect(result.candidates.map((c) => c.token)).toEqual([fakeToken('b')]);
  });
});

describe('noCopilotSessionError', () => {
  test('without a selection the message is unchanged', () => {
    expect(noCopilotSessionError(['Chrome', 'Firefox']).message).toBe(
      'No Copilot Money session found. Searched: Chrome, Firefox. ' +
        'Please log into Copilot Money at https://app.copilot.money in your browser, then try again.'
    );
  });

  test('FirebaseAuth surfaces the selection-specific message', async () => {
    const home = mkdtempSync(join(tmpdir(), 'browser-select-auth-'));
    try {
      mkdirSync(join(home, '.config/BraveSoftware/Brave-Browser/Default'), { recursive: true });
      const auth = new FirebaseAuth(() =>
        extractRefreshTokenCandidates(undefined, {
          platform: 'linux',
          home,
          env: {},
          selection: { browser: 'brave', profile: 'Default' },
        })
      );
      await expect(auth.getIdToken()).rejects.toThrow(
        'No Copilot Money session found in Brave (profile "Default").'
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
