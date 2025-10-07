// cjs-hook.js
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const babel = require('@babel/core');
const makeWrap = require('./wrap-plugin');
const { SYM_SRC_FILE, SYM_IS_APP } = require('./runtime');

const CWD = process.cwd().replace(/\\/g, '/');
const escapeRx = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// app file check (your existing logic)
function isAppFile(filename) {
    const f = String(filename || '').replace(/\\/g, '/');
    return f.startsWith(CWD + '/') && !f.includes('/node_modules/');
}

function toPosix(file) {
    return String(file || '').replace(/\\/g, '/');
}

function tagExports(value, filename, seen = new WeakSet(), depth = 0) {
    if (value == null) return;
    const ty = typeof value;
    if (ty !== 'object' && ty !== 'function') return;
    if (seen.has(value)) return;
    seen.add(value);

    const isApp = isAppFile(filename);

    if (typeof value === 'function') {
        try {
            if (!value[SYM_SRC_FILE]) {
                Object.defineProperty(value, SYM_SRC_FILE, { value: filename, configurable: true });
            }
            if (value[SYM_IS_APP] !== isApp) {
                Object.defineProperty(value, SYM_IS_APP, { value: isApp, configurable: true });
            }
        } catch {}
        const proto = value.prototype;
        if (proto && typeof proto === 'object') {
            for (const k of Object.getOwnPropertyNames(proto)) {
                if (k === 'constructor') continue;
                const d = Object.getOwnPropertyDescriptor(proto, k);
                if (!d) continue;
                if (typeof d.value === 'function') tagExports(d.value, filename, seen, depth + 1);
                // also tag accessors
                if (typeof d.get === 'function') tagExports(d.get, filename, seen, depth + 1);
                if (typeof d.set === 'function') tagExports(d.set, filename, seen, depth + 1);
            }
        }
    }

    if (typeof value === 'object' && depth < 4) {
        for (const k of Object.getOwnPropertyNames(value)) {
            const d = Object.getOwnPropertyDescriptor(value, k);
            if (!d) continue;

            if ('value' in d) tagExports(d.value, filename, seen, depth + 1);

            if (typeof d.get === 'function') {
                tagExports(d.get, filename, seen, depth + 1);
                try { tagExports(value[k], filename, seen, depth + 1); } catch {}
            }
            if (typeof d.set === 'function') {
                tagExports(d.set, filename, seen, depth + 1);
            }
        }
    }
}

function installCJS({ include, exclude, parserPlugins } = {}) {
    // default include = project dir; exclude node_modules
    const inc = Array.isArray(include) && include.length
        ? include
        : [ new RegExp('^' + escapeRx(CWD + '/')) ];
    const exc = Array.isArray(exclude) ? exclude : [];

    const shouldHandle = (f) => {
        const s = String(f || '').replace(/\\/g, '/');
        if (exc.some(rx => rx.test(s))) return false;
        return inc.some(rx => rx.test(s));
    };

    // ---- Global hook: intercept *all* compiles, regardless of how .ts was compiled ----
    const origCompile = Module.prototype._compile;
    Module.prototype._compile = function patchedCompile(code, filename) {
        let out = code;
        let metaFilename = filename;
        try {
            if (shouldHandle(filename) && isAppFile(filename)) {
                metaFilename = getOriginalSourceFilename(code, filename) || filename;
                // Transform the already-compiled JS (keeps Nest’s decorator metadata intact)
                const res = babel.transformSync(code, {
                    filename,
                    sourceType: 'unambiguous',
                    retainLines: true,
                    sourceMaps: 'inline',
                    parserOpts: {
                        sourceType: 'unambiguous',
                        // We’re parsing JS here; TS was compiled by ts-node/Nest.
                        plugins: parserPlugins || [
                            'jsx', 'classProperties', 'classPrivateProperties',
                            'classPrivateMethods', 'dynamicImport', 'topLevelAwait',
                            'optionalChaining', 'nullishCoalescingOperator',
                        ],
                    },
                    // only the wrap plugin; do NOT run TS transform here
                    plugins: [
                        [ makeWrap(metaFilename, { mode: 'all', wrapGettersSetters: false, skipAnonymous: false }) ],
                    ],
                    compact: false,
                    comments: true,
                });
                out = res?.code || code;
            }
        } catch {
            out = code; // never break the app if transform fails
        }

        const ret = origCompile.call(this, out, filename);

        // Tag exports for origin detection
        try { tagExports(this.exports, metaFilename); } catch {}

        return ret;
    };

    // keep your load wrapper to tag modules loaded in other ways too
    const _resolveFilename = Module._resolveFilename;
    const _load = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
        const filename = (() => {
            try { return _resolveFilename.call(Module, request, parent, isMain); }
            catch { return String(request); } // e.g., 'node:fs'
        })();
        const exp = _load.apply(this, arguments);
        try { tagExports(exp, filename); } catch {}
        return exp;
    };
}

function getOriginalSourceFilename(code, filename) {
    try {
        const map = loadSourceMap(code, filename);
        if (!map) return null;

        const { sources = [], sourceRoot } = map;
        if (!sources.length) return null;

        const resolvedSourceRoot = sourceRoot
            ? resolveSourcePath(sourceRoot, map.__mapFile || filename)
            : '';

        for (const src of sources) {
            if (!src) continue;
            const abs = resolveSourcePath(src, map.__mapFile || filename, resolvedSourceRoot);
            if (!abs) continue;
            return toPosix(abs);
        }
    } catch {}
    return null;
}

function resolveSourcePath(sourcePath, relativeTo, rootOverride) {
    try {
        const baseDir = path.dirname(relativeTo);
        const combined = rootOverride
            ? path.resolve(rootOverride, sourcePath)
            : path.resolve(baseDir, sourcePath);
        return combined;
    } catch {
        return null;
    }
}

function loadSourceMap(code, filename) {
    const match = /\/\/[#@]\s*sourceMappingURL=([^\s]+)/.exec(code);
    if (!match) return null;

    const url = match[1].trim();
    if (!url) return null;

    if (url.startsWith('data:')) {
        return parseDataUrl(url);
    }

    const mapPath = path.resolve(path.dirname(filename), url);
    try {
        const text = fs.readFileSync(mapPath, 'utf8');
        const json = JSON.parse(text);
        Object.defineProperty(json, '__mapFile', { value: mapPath });
        return json;
    } catch {
        return null;
    }
}

function parseDataUrl(url) {
    const comma = url.indexOf(',');
    if (comma < 0) return null;

    const meta = url.slice(5, comma);
    const data = url.slice(comma + 1);

    try {
        if (/;base64/i.test(meta)) {
            const buf = Buffer.from(data, 'base64');
            return JSON.parse(buf.toString('utf8'));
        }
        return JSON.parse(decodeURIComponent(data));
    } catch {
        return null;
    }
}

module.exports = { installCJS };