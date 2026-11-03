// Static consistency checks (partly compensating for not being able to run GJS here):
// GSettings keys used in the code = schema keys; valid metadata; files present.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readFileSync, cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';

const ext = new URL('../extension/', import.meta.url).pathname;
const read = f => readFileSync(join(ext, f), 'utf8');

const schemaXml = read('schemas/org.gnome.shell.extensions.viseur.gschema.xml');
const schemaKeys = new Set([...schemaXml.matchAll(/<key name="([^"]+)"/g)].map(m => m[1]));

function usedKeys(source) {
    const keys = new Set();
    for (const m of source.matchAll(/(?:get|set|reset)_(?:boolean|string|strv|int)\(\s*'([a-z0-9-]+)'/g))
        keys.add(m[1]);
    for (const m of source.matchAll(/changed::([a-z0-9-]+)/g))
        keys.add(m[1]);
    for (const m of source.matchAll(/settings\.(?:reset)\(\s*'([a-z0-9-]+)'/g))
        keys.add(m[1]);
    for (const m of source.matchAll(/_addKey\(\s*'([a-z0-9-]+)'/g))
        keys.add(m[1]);
    for (const m of source.matchAll(/\.bind\(\s*'([a-z0-9-]+)'/g))
        keys.add(m[1]);
    for (const m of source.matchAll(/^\s*\['([a-z0-9-]+-shortcut(?:-\d)?)',/gm))
        keys.add(m[1]);
    return keys;
}

test('every GSettings key used exists in the schema', () => {
    const used = new Set([...usedKeys(read('extension.js')), ...usedKeys(read('prefs.js'))]);
    assert.ok(used.size > 10);
    for (const k of used)
        assert.ok(schemaKeys.has(k), `key missing from schema: ${k}`);
});

test('profile-shortcut-N shortcuts are all registered (1..4 loop present)', () => {
    for (let i = 1; i <= 4; i++)
        assert.ok(schemaKeys.has(`profile-shortcut-${i}`));
    assert.match(read('extension.js'), /profile-shortcut-\$\{i\}/);
});

test('the default hold-profile exists among the presets', async () => {
    const {defaultProfiles} = await import('../extension/model.js');
    const def = /<key name="hold-profile"[^>]*>\s*<default>'([^']+)'/.exec(schemaXml)[1];
    assert.ok(defaultProfiles().some(p => p.id === def), `unknown preset: ${def}`);
});

test('the schema compiles in strict mode', () => {
    const dir = mkdtempSync(join(tmpdir(), 'viseur-schema-'));
    cpSync(join(ext, 'schemas'), dir, {recursive: true});
    execFileSync('glib-compile-schemas', ['--strict', dir]);
    assert.ok(existsSync(join(dir, 'gschemas.compiled')));
});

test('metadata.json is consistent', () => {
    const meta = JSON.parse(read('metadata.json'));
    assert.match(meta.uuid, /^[a-z0-9._-]+@[a-z0-9._-]+$/i);
    assert.ok(meta['shell-version'].includes('51'));
    assert.equal(meta['settings-schema'], 'org.gnome.shell.extensions.viseur');
    assert.match(schemaXml, new RegExp(`id="${meta['settings-schema'].replace(/\./g, '\\.')}"`));
    for (const f of ['extension.js', 'prefs.js', 'model.js', 'renderer.js', 'profiles.js', 'icons/viseur-symbolic.svg'])
        assert.ok(existsSync(join(ext, f)), `missing file: ${f}`);
});

test('the UUID is the same in the scripts, the PKGBUILD and the code', () => {
    const uuid = JSON.parse(read('metadata.json')).uuid;
    for (const f of ['../scripts/install.sh', '../scripts/uninstall.sh', '../scripts/viseurctl', '../packaging/PKGBUILD', 'prefs.js'])
        assert.ok(read(f).includes(uuid), `UUID missing from ${f}`);
});

test('no X11 / wmctrl / always-on-top window dependency in the code', () => {
    for (const f of ['extension.js', 'prefs.js', 'model.js', 'renderer.js', 'profiles.js']) {
        const src = read(f).replace(/\/\/.*$/gm, '');
        assert.doesNotMatch(src, /wmctrl|xdotool|Gdk\.X11|make_above|stick\(\)/, f);
    }
});

test('no gettext _() call at module level (before the first class)', () => {
    // gettext is only usable once the extension is loaded: _() at top level breaks prefs.js.
    for (const f of ['extension.js', 'prefs.js']) {
        const src = read(f);
        const head = src.slice(0, src.search(/^(export default )?class |^const \w+ = GObject\.registerClass/m));
        let code = head.replace(/\/\/.*$/gm, '').replace(/^import .*$/gm, '');
        // Bodies of declared functions only run when called: strip them.
        for (;;) {
            const m = /^function \w+\([^)]*\)\s*\{/m.exec(code);
            if (!m)
                break;
            let depth = 1, i = m.index + m[0].length;
            while (i < code.length && depth > 0)
                depth += code[i] === '{' ? 1 : code[i] === '}' ? -1 : 0, i++;
            code = code.slice(0, m.index) + code.slice(i);
        }
        assert.doesNotMatch(code, /[^\w$.]_\(/, `${f}: _() called at module level`);
    }
});

test('affectsInputRegion is never passed to addChrome (rejected by Shell 50+)', () => {
    assert.doesNotMatch(read('extension.js'), /affectsInputRegion/);
});

test('metadata.json follows the extensions.gnome.org rules', () => {
    const meta = JSON.parse(read('metadata.json'));
    assert.deepEqual(meta['shell-version'], ['50', '51']);
    assert.equal(meta.version, undefined, '"version" is set by extensions.gnome.org');
    assert.match(meta['version-name'], /^(?!^[. ]+$)[a-zA-Z0-9 .]{1,16}$/);
    assert.match(meta.url, /^https:\/\/(github|gitlab)\.com\/[^/]+\/[^/]+$/);
    assert.equal(meta['session-modes'], undefined, 'only "user" mode: the key must be dropped');
    assert.equal(meta['gettext-domain'], meta.uuid);
    assert.match(schemaXml, new RegExp(`gettext-domain="${meta.uuid}"`));
    assert.match(schemaXml, /path="\/org\/gnome\/shell\/extensions\//);
});

test('the version follows SemVer and matches metadata.json, the PKGBUILD and CHANGELOG.md', () => {
    const version = JSON.parse(read('metadata.json'))['version-name'];
    assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'MAJOR.MINOR.PATCH');
    assert.match(read('../packaging/PKGBUILD'), new RegExp(`^pkgver=${version.replace(/\./g, '\\.')}$`, 'm'));

    const changelog = read('../CHANGELOG.md');
    assert.match(changelog, /^## \[Unreleased\]$/m);
    const latest = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/m.exec(changelog);
    assert.ok(latest, 'a "## [X.Y.Z] - YYYY-MM-DD" release section');
    assert.equal(latest[1], version, 'latest CHANGELOG release = version-name');
    assert.match(changelog, new RegExp(`^\\[${version.replace(/\./g, '\\.')}\\]: https://`, 'm'),
        'release link at the bottom');
});

test('process separation: no GTK in the Shell process, no Shell libraries in prefs', () => {
    for (const f of ['extension.js', 'model.js', 'renderer.js', 'profiles.js'])
        assert.doesNotMatch(read(f), /from 'gi:\/\/(Gtk|Gdk|Adw)'/, f);
    for (const f of ['prefs.js', 'model.js', 'renderer.js', 'profiles.js'])
        assert.doesNotMatch(read(f), /from 'gi:\/\/(Clutter|Meta|St|Shell)'/, f);
});

test('no debug logging in the extension (errors only)', () => {
    for (const f of ['extension.js', 'prefs.js', 'model.js', 'renderer.js', 'profiles.js'])
        assert.doesNotMatch(read(f), /console\.(log|debug|info|warn)\(|\blog\(/, f);
});

test('unredirection is inhibited while visible and always released (fullscreen visibility)', () => {
    const src = read('extension.js').replace(/\/\/.*$/gm, '');
    assert.equal([...src.matchAll(/global\.compositor\.disable_unredirect\(\)/g)].length, 1);
    assert.equal([...src.matchAll(/global\.compositor\.enable_unredirect\(\)/g)].length, 1);
    assert.match(src, /this\._setUnredirect\(!visible\)/);
    assert.match(src, /destroy\(\) \{\s*this\._setUnredirect\(true\)/);
});

test('right-click hold uses the measured right-button mask (BUTTON2, not BUTTON3)', () => {
    const src = read('extension.js').replace(/\/\/.*$/gm, '');
    assert.match(src, /const RIGHT_BUTTON_MASK = Clutter\.ModifierType\.BUTTON2_MASK;/);
    assert.match(src, /& RIGHT_BUTTON_MASK\) !== 0/);
    assert.doesNotMatch(src, /BUTTON3_MASK/);
    assert.doesNotMatch(src, /viseur\] debug/, 'temporary diagnostic removed');
});

test('right click offers an exclusive Off / Hold / Toggle choice (schema, panel menu, prefs)', () => {
    const key = /<key name="rightclick-mode"[\s\S]*?<\/key>/.exec(schemaXml)?.[0] ?? '';
    const choices = [...key.matchAll(/<choice value="([^"]+)"/g)].map(m => m[1]).sort();
    assert.deepEqual(choices, ['hold', 'toggle']);
    assert.match(key, /<default>'hold'<\/default>/);
    const ext = read('extension.js');
    for (const mode of ['off', 'hold', 'toggle'])
        assert.match(ext, new RegExp(`\\['${mode}', _\\(`), `panel menu entry ${mode}`);
    assert.match(ext, /setRightClickMode\(mode\)/);
    assert.match(read('prefs.js'), /const modes = \['off', 'hold', 'toggle'\];/);
});

test('shell scripts pass bash -n', () => {
    for (const f of ['install.sh', 'uninstall.sh', 'viseurctl'])
        execFileSync('bash', ['-n', new URL(`../scripts/${f}`, import.meta.url).pathname]);
});
