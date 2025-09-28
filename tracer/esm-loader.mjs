// esm-loader.mjs
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as babel from '@babel/core';
import tsPlugin from '@babel/plugin-transform-typescript';
import makeWrap from './wrap-plugin.js';

const parserPlugins = [
    'jsx',
    ['decorators', { version: 'legacy' }], // adjust per your stack
    'classProperties','classPrivateProperties','classPrivateMethods',
    'dynamicImport','topLevelAwait','typescript'
];

// naive include/exclude based on CWD by default
const CWD = process.cwd().replace(/\\/g,'/');
const include = [ new RegExp('^' + CWD.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\$&') + '/') ];
const exclude = [ /node_modules[\\/]/ ];

export async function resolve(specifier, context, next) {
    const r = await next(specifier, context);
    return r; // default resolution
}

export async function load(url, context, next) {
    const r = await next(url, context);
    if (r.format !== 'module' && r.format !== 'commonjs') return r;

    const filename = url.startsWith('file:') ? fileURLToPath(url) : null;
    if (!filename) return r;

    const s = filename.replace(/\\/g,'/');
    if (exclude.some(rx => rx.test(s)) || !include.some(rx => rx.test(s))) return r;

    const code = await readFile(filename, 'utf8');
    const out = babel.transformSync(code, {
        filename,
        sourceType: 'unambiguous',
        retainLines: true,
        parserOpts: { sourceType:'unambiguous', plugins: parserPlugins },
        plugins: [[ makeWrap(filename) ], [ tsPlugin, { allowDeclareFields:true } ]],
        sourceMaps: 'inline',
    })?.code || code;

    return { format: r.format, source: out };
}
