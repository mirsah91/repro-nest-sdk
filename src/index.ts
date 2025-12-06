import type { Request, Response, NextFunction } from 'express';
import type { Schema, Model, Query } from 'mongoose';
import * as mongoose from 'mongoose';
import { AsyncLocalStorage } from 'async_hooks';

/**
 * ============================= IMPORTANT =============================
 * We snapshot Mongoose core methods BEFORE tracer init, then re-apply them
 * AFTER tracer init. This guarantees Model.find() still returns a Query and
 * chainability (e.g., .sort().lean()) is preserved. No behavior changes.
 * =====================================================================
 */
const __ORIG = (() => {
    const M: any = (mongoose as any).Model;
    const Qp: any = (mongoose as any).Query?.prototype;
    const Ap: any = (mongoose as any).Aggregate?.prototype;
    return {
        Model: {
            find: M?.find,
            findOne: M?.findOne,
            findById: M?.findById,
            create: M?.create,
            insertMany: M?.insertMany,
            updateOne: M?.updateOne,
            updateMany: M?.updateMany,
            replaceOne: M?.replaceOne,
            deleteOne: M?.deleteOne,
            deleteMany: M?.deleteMany,
            countDocuments: M?.countDocuments,
            estimatedDocumentCount: M?.estimatedDocumentCount,
            distinct: M?.distinct,
            findOneAndUpdate: M?.findOneAndUpdate,
            findOneAndDelete: M?.findOneAndDelete,
            findOneAndReplace: M?.findOneAndReplace,
            findOneAndRemove: M?.findOneAndRemove,
            bulkWrite: M?.bulkWrite,
        },
        Query: {
            exec: Qp?.exec,
            lean: Qp?.lean,
            sort: Qp?.sort,
            select: Qp?.select,
            limit: Qp?.limit,
            skip: Qp?.skip,
            populate: Qp?.populate,
            getFilter: Qp?.getFilter,
            getUpdate: Qp?.getUpdate,
            getOptions: Qp?.getOptions,
            projection: Qp?.projection,
        },
        Aggregate: {
            exec: Ap?.exec,
        }
    };
})();

function restoreMongooseIfNeeded() {
    try {
        const M: any = (mongoose as any).Model;
        const Qp: any = (mongoose as any).Query?.prototype;
        const Ap: any = (mongoose as any).Aggregate?.prototype;
        const safeSet = (obj: any, key: string, val: any) => {
            if (!obj || !val) return;
            if (obj[key] !== val) { try { obj[key] = val; } catch {} }
        };

        // Restore Model methods (chainability depends on these returning Query)
        Object.entries(__ORIG.Model).forEach(([k, v]) => safeSet(M, k, v));

        // Restore Query prototype essentials (exec/lean/etc.)
        Object.entries(__ORIG.Query).forEach(([k, v]) => safeSet(Qp, k, v));

        // Restore Aggregate exec
        Object.entries(__ORIG.Aggregate).forEach(([k, v]) => safeSet(Ap, k, v));
    } catch {}
}

function flushQueryFinalizers(query: any, value: any, threw: boolean, error: any) {
    try {
        const callbacks = (query as any)?.__repro_query_finalizers;
        if (!Array.isArray(callbacks) || callbacks.length === 0) return;
        (query as any).__repro_query_finalizers = [];
        for (const fn of callbacks) {
            try { fn(value, threw, error); } catch {}
        }
    } catch {}
}

function patchMongooseExecCapture() {
    try {
        const Qp: any = (mongoose as any).Query?.prototype;
        if (!Qp || Qp.__repro_exec_patched) return;
        const origExec = Qp.exec;
        if (typeof origExec !== 'function') return;
        Qp.__repro_exec_patched = true;
        Qp.exec = function reproPatchedExec(this: any, ...args: any[]) {
            try { (this as any).__repro_is_query = true; } catch {}
            const p = origExec.apply(this, args);
            try {
                if (p && typeof p.then === 'function') {
                    this.__repro_result_promise = p;
                    p.then(
                        (res: any) => {
                            try { this.__repro_result = res; } catch {}
                            flushQueryFinalizers(this, res, false, null);
                            return res;
                        },
                        (err: any) => {
                            flushQueryFinalizers(this, undefined, true, err);
                            return err;
                        }
                    );
                }
            } catch {}
            return p;
        };
    } catch {}
}

// ====== tiny, safe tracer auto-init (no node_modules patches) ======
type TracerApi = {
    init?: (opts: any) => void;
    tracer?: { on: (fn: (ev: any) => void) => () => void };
    getCurrentTraceId?: () => string | null;
    patchHttp?: () => void; // optional in your tracer
    setFunctionLogsEnabled?: (enabled: boolean) => void;
};

const REQUEST_START_HEADER = 'x-bug-request-start';

function escapeRx(s: string) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
let __TRACER__: TracerApi | null = null;
let __TRACER_READY = false;

type TraceEventPhase = 'enter' | 'exit';
export type TraceRulePattern = string | RegExp | Array<string | RegExp>;

export type TraceEventForFilter = {
    type: TraceEventPhase; // legacy alias for eventType
    eventType: TraceEventPhase;
    functionType?: string | null;
    fn?: string;
    file?: string | null;
    depth?: number;
    library?: string | null;
};

type TraceEventRecord = {
    t: number;
    type: 'enter' | 'exit';
    functionType?: string | null;
    fn?: string;
    file?: string;
    line?: number | null;
    depth?: number;
    spanId?: string | number | null;
    parentSpanId?: string | number | null;
    args?: any;
    returnValue?: any;
    threw?: boolean;
    error?: any;
    unawaited?: boolean;
};

type EndpointTraceInfo = {
    fn: string | null;
    file: string | null;
    line: number | null;
    functionType: string | null;
};

export type HeaderRule = string | RegExp;
export type HeaderCaptureOptions = {
    /** When true, sensitive headers such as Authorization are kept; default redacts them. */
    allowSensitiveHeaders?: boolean;
    /** Additional header names (string or RegExp) to drop from captures. */
    dropHeaders?: HeaderRule | HeaderRule[];
    /** Explicit allowlist that overrides defaults and drop rules. */
    keepHeaders?: HeaderRule | HeaderRule[];
};

type NormalizedHeaderCapture = {
    enabled: boolean;
    allowSensitive: boolean;
    drop: HeaderRule[];
    keep: HeaderRule[];
};

/** Lightweight helper to disable every trace emitted from specific files. */
export interface DisableTraceByFilename {
    file: TraceRulePattern;
}

type DisableTraceFileConfig = TraceRulePattern | DisableTraceByFilename | null | undefined;

/**
 * Declarative rule that disables trace events matching the provided patterns.
 *
 * Each property accepts a string (substring match), a RegExp, or an array of
 * either. When an array is provided, a single match of any entry is enough to
 * drop the event. Provide no value to leave that dimension unrestricted.
 */
export type DisableFunctionTraceRule = {
    /** Shortcut for {@link functionName}. */
    fn?: TraceRulePattern;
    /** Function name (e.g. `"findOne"`, `/^UserService\./`). */
    functionName?: TraceRulePattern;
    /** Absolute file path where the function was defined. */
    file?: TraceRulePattern;
    /** Shortcut for {@link library}. */
    lib?: TraceRulePattern;
    /** Library/package name inferred from the file path (e.g. `"mongoose"`). */
    library?: TraceRulePattern;
    /** Shortcut for {@link functionType}. */
    type?: TraceRulePattern;
    /** Function classification such as `"constructor"`, `"method"`, or `"arrow"`. */
    functionType?: TraceRulePattern;
    /** Shortcut for {@link eventType}. */
    event?: TraceRulePattern;
    /** Trace phase to filter (`"enter"` or `"exit"`). */
    eventType?: TraceRulePattern;
};

export type DisableFunctionTracePredicate = (event: TraceEventForFilter) => boolean;

export type DisableFunctionTraceConfig =
    | DisableFunctionTraceRule
    | DisableFunctionTracePredicate;

const DEFAULT_INTERCEPTOR_TRACE_RULES: DisableFunctionTraceConfig[] = [
    { fn: /switchToHttp$/i },
    { fn: /intercept$/i },
];

let interceptorTracingEnabled = false;
let userDisabledFunctionTraceRules: DisableFunctionTraceConfig[] | null = null;

function computeDisabledFunctionTraceRules(
    rules?: DisableFunctionTraceConfig[] | null,
): DisableFunctionTraceConfig[] {
    const normalized = Array.isArray(rules)
        ? rules.filter((rule): rule is DisableFunctionTraceConfig => !!rule)
        : [];
    if (interceptorTracingEnabled) {
        return normalized;
    }
    return [...DEFAULT_INTERCEPTOR_TRACE_RULES, ...normalized];
}

function refreshDisabledFunctionTraceRules() {
    disabledFunctionTraceRules = computeDisabledFunctionTraceRules(userDisabledFunctionTraceRules);
}

let disabledFunctionTraceRules: DisableFunctionTraceConfig[] = computeDisabledFunctionTraceRules();
let disabledFunctionTypePatterns: Array<string | RegExp> = [];
let disabledTraceFilePatterns: Array<string | RegExp> = [];
let __TRACE_LOG_PREF: boolean | null = null;

function setInterceptorTracingEnabled(enabled: boolean) {
    const next = !!enabled;
    if (interceptorTracingEnabled === next) return;
    interceptorTracingEnabled = next;
    refreshDisabledFunctionTraceRules();
}

function hasOwn(obj: unknown, key: string): boolean {
    return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizePatternArray<T>(pattern?: T | T[] | null): Exclude<T, null | undefined>[] {
    if (pattern === undefined || pattern === null) return [];
    const arr = Array.isArray(pattern) ? pattern : [pattern];
    return arr.filter((entry): entry is Exclude<T, null | undefined> => entry !== undefined && entry !== null);
}

function matchesPattern(
    value: string | null | undefined,
    pattern?: TraceRulePattern,
    defaultWhenEmpty: boolean = true,
): boolean {
    if (pattern === undefined || pattern === null) return defaultWhenEmpty;
    const val = value == null ? '' : String(value);
    const candidates = normalizePatternArray(pattern);
    if (!candidates.length) return defaultWhenEmpty;
    return candidates.some(entry => {
        if (entry instanceof RegExp) {
            try { return entry.test(val); } catch { return false; }
        }
        const needle = String(entry).toLowerCase();
        if (!needle) return val === '';
        return val.toLowerCase().includes(needle);
    });
}

function inferLibraryNameFromFile(file?: string | null): string | null {
    if (!file) return null;
    const normalized = String(file).replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/node_modules/');
    if (idx === -1) return null;
    const remainder = normalized.slice(idx + '/node_modules/'.length);
    if (!remainder) return null;
    const segments = remainder.split('/');
    if (!segments.length) return null;
    if (segments[0].startsWith('@') && segments.length >= 2) {
        return `${segments[0]}/${segments[1]}`;
    }
    return segments[0] || null;
}

function matchesRule(rule: DisableFunctionTraceRule, event: TraceEventForFilter): boolean {
    const namePattern = rule.fn ?? rule.functionName;
    if (!matchesPattern(event.fn, namePattern)) return false;

    if (!matchesPattern(event.file, rule.file)) return false;

    const libPattern = rule.lib ?? rule.library;
    if (!matchesPattern(event.library, libPattern)) return false;

    const fnTypePattern = rule.functionType ?? rule.type;
    if (!matchesPattern(event.functionType, fnTypePattern)) return false;

    const eventTypePattern = rule.eventType ?? rule.event;
    if (!matchesPattern(event.eventType, eventTypePattern)) return false;

    return true;
}

function shouldDropTraceEvent(event: TraceEventForFilter): boolean {
    if (disabledTraceFilePatterns.length) {
        if (matchesPattern(event.file, disabledTraceFilePatterns, false)) {
            return true;
        }
    }
    if (disabledFunctionTypePatterns.length) {
        if (matchesPattern(event.functionType, disabledFunctionTypePatterns, false)) {
            return true;
        }
    }
    if (!disabledFunctionTraceRules.length) return false;
    for (const rule of disabledFunctionTraceRules) {
        try {
            if (typeof rule === 'function') {
                if (rule(event)) return true;
            } else if (matchesRule(rule, event)) {
                return true;
            }
        } catch {
            // ignore user filter errors
        }
    }
    return false;
}

export function setDisabledFunctionTraces(rules?: DisableFunctionTraceConfig[] | null) {
    if (!rules || !Array.isArray(rules)) {
        userDisabledFunctionTraceRules = null;
    } else {
        userDisabledFunctionTraceRules = rules.filter((rule): rule is DisableFunctionTraceConfig => !!rule);
    }
    refreshDisabledFunctionTraceRules();
}

export function setDisabledFunctionTypes(patterns?: TraceRulePattern | null) {
    disabledFunctionTypePatterns = normalizePatternArray(patterns);
}

function flattenTraceFilePatterns(config: DisableTraceFileConfig): Array<string | RegExp> {
    if (config === null || config === undefined) return [];
    if (Array.isArray(config)) {
        return config.flatMap(entry => flattenTraceFilePatterns(entry));
    }
    if (config instanceof RegExp || typeof config === 'string') {
        return [config];
    }
    if (typeof config === 'object' && 'file' in config) {
        return normalizePatternArray(config.file);
    }
    return [];
}

export function setDisabledTraceFiles(config?: DisableTraceFileConfig | DisableTraceFileConfig[] | null) {
    if (config === null || config === undefined) {
        disabledTraceFilePatterns = [];
        return;
    }
    const items = Array.isArray(config) ? config : [config];
    disabledTraceFilePatterns = items.flatMap(entry => flattenTraceFilePatterns(entry)).filter(Boolean);
}

function applyTraceLogPreference(tracer?: TracerApi | null) {
    if (__TRACE_LOG_PREF === null) return;
    try { tracer?.setFunctionLogsEnabled?.(__TRACE_LOG_PREF); } catch {}
}

export function setReproTraceLogsEnabled(enabled: boolean) {
    __TRACE_LOG_PREF = !!enabled;
    applyTraceLogPreference(__TRACER__);
}

export function enableReproTraceLogs() { setReproTraceLogsEnabled(true); }

export function disableReproTraceLogs() { setReproTraceLogsEnabled(false); }

function summarizeEndpointFromEvents(events: TraceEventRecord[]) {
    let endpointTrace: EndpointTraceInfo | null = null;
    let preferredAppTrace: EndpointTraceInfo | null = null;
    let firstAppTrace: EndpointTraceInfo | null = null;

    for (const evt of events) {
        if (evt.type !== 'enter') continue;
        if (!isLikelyAppFile(evt.file)) continue;
        const depthOk = evt.depth === undefined || evt.depth <= 6;
        const trace = toEndpointTrace(evt);

        if (!firstAppTrace && depthOk) {
            firstAppTrace = trace;
        }

        if (isLikelyNestControllerFile(evt.file)) {
            endpointTrace = trace;
        } else if (depthOk && !preferredAppTrace && !isLikelyNestGuardFile(evt.file)) {
            preferredAppTrace = trace;
        }
    }

    return { endpointTrace, preferredAppTrace, firstAppTrace };
}

// (function ensureTracerAutoInit() {
//     if (__TRACER_READY) return;
//
//     try {
//         const tracerPkg: TracerApi = require('../tracer');
//
//         const cwd = process.cwd().replace(/\\/g, '/');
//         const sdkRoot = __dirname.replace(/\\/g, '/');
//
//         // include ONLY app code (no node_modules) to avoid interfering with deps
//         const include = [ new RegExp('^' + escapeRx(cwd) + '/(?!node_modules/)') ];
//
//         // exclude this SDK itself (and any babel internals if present)
//         const exclude = [
//             new RegExp('^' + escapeRx(sdkRoot) + '/'),
//             /node_modules[\\/]@babel[\\/].*/,
//         ];
//
//         tracerPkg.init?.({
//             instrument: true,               // tracer can instrument app code
//             include,
//             exclude,                        // but never our SDK
//             mode: process.env.TRACE_MODE || 'v8',
//             samplingMs: 10,
//         });
//
//         tracerPkg.patchHttp?.();
//
//         __TRACER__ = tracerPkg;
//         __TRACER_READY = true;
//     } catch {
//         __TRACER__ = null; // optional tracer
//     } finally {
//         // Critical: make sure Mongoose core is pristine after tracer init.
//         restoreMongooseIfNeeded();
//         // And again on next tick (if tracer defers some wrapping)
//         setImmediate(restoreMongooseIfNeeded);
//     }
// })();
// ===================================================================

// ===== Configurable tracer init (explicit, no auto-run) =====
type TracerInitOpts = {
    instrument?: boolean;
    include?: RegExp[];
    exclude?: RegExp[];
    mode?: string;
    samplingMs?: number;
};

export type ReproTracingInitOptions = TracerInitOpts & {
    /**
     * Optional list of rules or predicates that suppress unwanted function
     * trace events. When omitted, every instrumented function will be
     * recorded. Provide an empty array to reset filters after a previous call.
     */
    disableFunctionTraces?: DisableFunctionTraceConfig[] | null;
    /**
     * Convenience filter that disables every trace event emitted for the
     * provided function types (e.g. `"constructor"`). Accepts a string,
     * regular expression, or array matching the rule syntax above.
     */
    disableFunctionTypes?: TraceRulePattern | null;
    /**
     * Prevents traces emitted from specific files. Accepts glob-like substrings
     * or regular expressions, or the {@link DisableTraceByFilename} helper.
     */
    disableTraceFiles?: DisableTraceFileConfig | DisableTraceFileConfig[] | null;
    /**
     * When `false` (default) Nest interceptors are stripped from traces.
     * Set to `true` to include them if you need to debug interceptor logic.
     */
    traceInterceptors?: boolean;
    /**
     * Enables or silences console logs emitted by the tracer when functions
     * are entered/exited. Equivalent to calling `setReproTraceLogsEnabled`.
     */
    logFunctionCalls?: boolean;
};

function defaultTracerInitOpts(): TracerInitOpts {
    const cwd = process.cwd().replace(/\\/g, '/');
    const sdkRoot = __dirname.replace(/\\/g, '/');
    const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const include = [ new RegExp('^' + escapeRx(cwd) + '/(?!node_modules/)') ];
    // Only skip our own files and Babel internals; repository/service layers stay instrumented.
    const exclude = [
        new RegExp('^' + escapeRx(sdkRoot) + '/'), // never instrument the SDK itself
        /node_modules[\\/]@babel[\\/].*/,
    ];

    return {
        instrument: true,
        include,
        exclude,
        mode: process.env.TRACE_MODE || 'trace',
        samplingMs: 10,
    };
}

/** Call this from the client app to enable tracing. Safe to call multiple times. */
export function initReproTracing(opts?: ReproTracingInitOptions) {
    const options = opts ?? {};

    if (hasOwn(options, 'traceInterceptors')) {
        setInterceptorTracingEnabled(!!options.traceInterceptors);
    }
    if (hasOwn(options, 'disableFunctionTypes')) {
        setDisabledFunctionTypes(options.disableFunctionTypes ?? null);
    }
    if (hasOwn(options, 'disableFunctionTraces')) {
        setDisabledFunctionTraces(options.disableFunctionTraces ?? null);
    }
    if (hasOwn(options, 'disableTraceFiles')) {
        setDisabledTraceFiles(options.disableTraceFiles ?? null);
    }
    if (hasOwn(options, 'logFunctionCalls') && typeof options.logFunctionCalls === 'boolean') {
        setReproTraceLogsEnabled(options.logFunctionCalls);
    }

    if (__TRACER_READY) {
        applyTraceLogPreference(__TRACER__);
        return __TRACER__;
    }
    try {
        const tracerPkg: TracerApi = require('../tracer');
        __TRACER__ = tracerPkg;

        applyTraceLogPreference(tracerPkg);

        const {
            disableFunctionTraces: _disableFunctionTraces,
            disableFunctionTypes: _disableFunctionTypes,
            disableTraceFiles: _disableTraceFiles,
            logFunctionCalls: _logFunctionCalls,
            traceInterceptors: _traceInterceptors,
            ...rest
        } = options;
        const initOpts = { ...defaultTracerInitOpts(), ...(rest as TracerInitOpts) };
        tracerPkg.init?.(initOpts);
        tracerPkg.patchHttp?.();
        applyTraceLogPreference(tracerPkg);
        __TRACER_READY = true;
        patchMongooseExecCapture();
    } catch {
        __TRACER__ = null; // SDK still works without tracer
    } finally {
        // keep Mongoose prototypes pristine in either case
        restoreMongooseIfNeeded();
        setImmediate(restoreMongooseIfNeeded);
    }
    return __TRACER__;
}

/** Optional helper if users want to check it. */
export function isReproTracingEnabled() { return __TRACER_READY; }

type Ctx = { sid?: string; aid?: string; clockSkewMs?: number };
const als = new AsyncLocalStorage<Ctx>();
const getCtx = () => als.getStore() || {};

function currentClockSkewMs(): number {
    const store = als.getStore();
    const skew = store?.clockSkewMs;
    return Number.isFinite(skew) ? Number(skew) : 0;
}

function alignTimestamp(ms: number): number {
    if (!Number.isFinite(ms)) return ms;
    const skew = currentClockSkewMs();
    return Number.isFinite(skew) ? ms + skew : ms;
}

function alignedNow(): number {
    return alignTimestamp(Date.now());
}

function balanceTraceEvents(events: TraceEventRecord[]): TraceEventRecord[] {
    if (!Array.isArray(events) || events.length === 0) return events;

    const makeKey = (ev: TraceEventRecord) =>
        [ev.fn || '', ev.file || '', String(ev.line ?? ''), ev.functionType || ''].join('|');

    const seenKeys = new Set<string>();
    const balanced: TraceEventRecord[] = [];

    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (!ev || (ev.type !== 'enter' && ev.type !== 'exit')) {
            balanced.push(ev);
            continue;
        }

        balanced.push(ev);
        if (ev.type !== 'enter') continue;

        const key = makeKey(ev);
        if (!key || seenKeys.has(key)) continue;

        let hasExit = false;
        for (let j = i + 1; j < events.length; j++) {
            const later = events[j];
            if (later && later.type === 'exit' && makeKey(later) === key) {
                hasExit = true;
                break;
            }
        }

        if (!hasExit) {
            seenKeys.add(key);
            balanced.push({
                t: ev.t,
                type: 'exit',
                fn: ev.fn,
                file: ev.file,
                line: ev.line,
                functionType: ev.functionType,
                depth: typeof ev.depth === 'number' ? Math.max(0, ev.depth - 1) : ev.depth,
                spanId: ev.spanId ?? null,
                parentSpanId: ev.parentSpanId ?? null,
                args: ev.args,
                returnValue: undefined,
                threw: false,
                error: undefined,
                unawaited: true,
            });
        }
    }

    return balanced;
}

function reorderTraceEvents(events: TraceEventRecord[]): TraceEventRecord[] {
    if (!Array.isArray(events) || !events.length) return events;

    type SpanNode = {
        id: string;
        parentId: string | null;
        enter?: TraceEventRecord;
        exit?: TraceEventRecord;
        children: SpanNode[];
        order: number;
    };

    const nodes = new Map<string, SpanNode>();
    const roots: Array<SpanNode | { order: number; ev: TraceEventRecord }> = [];

    const normalizeId = (v: any) => (v === null || v === undefined ? null : String(v));

    const ensureNode = (id: string): SpanNode => {
        let n = nodes.get(id);
        if (!n) {
            n = { id, parentId: null, children: [], order: Number.POSITIVE_INFINITY };
            nodes.set(id, n);
        }
        return n;
    };

    events.forEach((ev, idx) => {
        const spanId = normalizeId(ev.spanId);
        const parentId = normalizeId(ev.parentSpanId);
        if (!spanId) {
            roots.push({ order: idx, ev });
            return;
        }
        const node = ensureNode(spanId);
        node.order = Math.min(node.order, idx);
        node.parentId = parentId;
        if (ev.type === 'enter') node.enter = node.enter ?? ev;
        if (ev.type === 'exit') node.exit = ev;
    });

    nodes.forEach(node => {
        if (node.parentId && nodes.has(node.parentId)) {
            const parent = nodes.get(node.parentId)!;
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    });

    const sortChildren = (node: SpanNode) => {
        node.children.sort((a, b) => a.order - b.order);
        node.children.forEach(sortChildren);
    };
    nodes.forEach(sortChildren);

    roots.sort((a, b) => a.order - b.order);

    const out: TraceEventRecord[] = [];
    const emitNode = (node: SpanNode, depth: number) => {
        if (node.enter) {
            node.enter.depth = depth;
            out.push(node.enter);
        }
        node.children.forEach(child => emitNode(child, depth + 1));
        if (node.exit) {
            node.exit.depth = depth;
            out.push(node.exit);
        }
    };

    roots.forEach(entry => {
        if ('ev' in entry) {
            out.push(entry.ev);
        } else {
            emitNode(entry as SpanNode, 1);
        }
    });

    return out;
}

function getCollectionNameFromDoc(doc: any): string | undefined {
    const direct =
        doc?.$__?.collection?.collectionName ||
        (doc?.$collection as any)?.collectionName ||
        doc?.collection?.collectionName ||
        (doc?.collection as any)?.name ||
        (doc?.constructor as any)?.collection?.collectionName;

    if (direct) return direct;

    if (doc?.$isSubdocument && typeof doc.ownerDocument === 'function') {
        const parent = doc.ownerDocument();
        return (
            parent?.$__?.collection?.collectionName ||
            (parent?.$collection as any)?.collectionName ||
            parent?.collection?.collectionName ||
            (parent?.collection as any)?.name ||
            (parent?.constructor as any)?.collection?.collectionName
        );
    }

    const ctor = doc?.constructor as any;
    if (ctor?.base && ctor?.base?.collection?.collectionName) {
        return ctor.base.collection.collectionName;
    }

    return undefined;
}

function getCollectionNameFromQuery(q: any): string | undefined {
    return q?.model?.collection?.collectionName || (q?.model?.collection as any)?.name;
}

function resolveCollectionOrWarn(source: any, type: 'doc' | 'query'): string {
    const name =
        (type === 'doc'
            ? getCollectionNameFromDoc(source)
            : getCollectionNameFromQuery(source)) || undefined;

    if (!name) {
        try {
            const modelName =
                type === 'doc'
                    ? (source?.constructor as any)?.modelName ||
                    (source?.ownerDocument?.() as any)?.constructor?.modelName
                    : source?.model?.modelName;
            // eslint-disable-next-line no-console
            console.warn('[repro] could not resolve collection name', { type, modelName });
        } catch {}
        return 'unknown';
    }
    return name;
}

async function post(
    apiBase: string,
    tenantId: string,
    appId: string,
    appSecret: string,
    sessionId: string,
    body: any,
) {
    try {
        await fetch(`${apiBase}/v1/sessions/${sessionId}/backend`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-App-Id': appId,
                'X-App-Secret': appSecret,
                'X-Tenant-Id': tenantId,
            },
            body: JSON.stringify(body),
        });
    } catch { /* swallow in SDK */ }
}

function readHeaderNumber(value: string | string[] | undefined): number | null {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
}

// -------- helpers for response capture & grouping --------
function normalizeRouteKey(method: string, rawPath: string) {
    const base = (rawPath || '/').split('?')[0] || '/';
    return `${String(method || 'GET').toUpperCase()} ${base}`;
}

function normalizeFilePath(file?: string | null): string {
    return file ? String(file).replace(/\\/g, '/').toLowerCase() : '';
}

function isLikelyAppFile(file?: string | null): boolean {
    if (!file) return false;
    const normalized = String(file).replace(/\\/g, '/');
    if (!normalized) return false;
    return !normalized.includes('/node_modules/');
}

function isLikelyNestControllerFile(file?: string | null): boolean {
    const normalized = normalizeFilePath(file);
    if (!normalized) return false;
    if (!isLikelyAppFile(file)) return false;
    return (
        normalized.includes('.controller.') ||
        normalized.includes('/controllers/') ||
        normalized.includes('.resolver.') ||
        normalized.includes('/resolvers/')
    );
}

function isLikelyNestGuardFile(file?: string | null): boolean {
    const normalized = normalizeFilePath(file);
    if (!normalized) return false;
    return normalized.includes('.guard.') || normalized.includes('/guards/');
}

function toEndpointTrace(evt: {
    fn?: string;
    file?: string;
    line?: number | null;
    functionType?: string | null;
}): EndpointTraceInfo {
    return {
        fn: evt.fn ?? null,
        file: evt.file ?? null,
        line: evt.line ?? null,
        functionType: evt.functionType ?? null,
    };
}

function coerceBodyToStorable(body: any, contentType?: string | number | string[]) {
    if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body;

    const ct = Array.isArray(contentType) ? String(contentType[0]) : String(contentType || '');
    const isLikelyJson = ct.toLowerCase().includes('application/json');

    try {
        if (Buffer.isBuffer(body)) {
            const s = body.toString('utf8');
            return isLikelyJson ? JSON.parse(s) : s;
        }
        if (typeof body === 'string') {
            return isLikelyJson ? JSON.parse(body) : body;
        }
    } catch {
        if (Buffer.isBuffer(body)) return body.toString('utf8');
        if (typeof body === 'string') return body;
    }
    return body;
}

const TRACE_VALUE_MAX_DEPTH = 3;
const TRACE_VALUE_MAX_KEYS = 20;
const TRACE_VALUE_MAX_ITEMS = 20;
const TRACE_VALUE_MAX_STRING = 2000;
const TRACE_BATCH_SIZE = 100;
const TRACE_FLUSH_DELAY_MS = 20;
// Extra grace period after res.finish to catch late fire-and-forget work before unsubscribing.
const TRACE_LINGER_AFTER_FINISH_MS = (() => {
    const env = Number(process.env.TRACE_LINGER_AFTER_FINISH_MS);
    if (Number.isFinite(env) && env >= 0) return env;
    return 1000; // default 1s to catch slow async callbacks (e.g., email sends)
})();
const TRACE_IDLE_FLUSH_MS = (() => {
    const env = Number(process.env.TRACE_IDLE_FLUSH_MS);
    if (Number.isFinite(env) && env > 0) return env;
    // Keep the listener alive until no new events arrive for this many ms after finish.
    return 2000;
})();

function isThenable(value: any): value is PromiseLike<any> {
    return value != null && typeof value === 'object' && typeof (value as any).then === 'function';
}

function coerceMongoId(value: any): string | null {
    if (!value) return null;
    const name = value?.constructor?.name;
    if (name === 'ObjectId' || name === 'ObjectID' || value?._bsontype === 'ObjectID') {
        try {
            if (typeof (value as any).toHexString === 'function') return (value as any).toHexString();
            if (typeof (value as any).toString === 'function') return (value as any).toString();
        } catch {}
        return '[mongo-id]';
    }
    return null;
}

function isMongoSessionLike(value: any): boolean {
    const ctor = value?.constructor?.name?.toLowerCase?.() || '';
    return (
        !!ctor &&
        ctor.includes('session') &&
        (typeof (value as any).endSession === 'function' || typeof (value as any).inTransaction === 'function')
    );
}

function describeMongoPlaceholder(value: any): string | null {
    const ctor = value?.constructor?.name;
    if (!ctor) return null;
    const lower = ctor.toLowerCase();

    if (isMongoSessionLike(value)) return 'mongo-session';
    if (lower.includes('cursor')) return 'mongo-cursor';
    if (lower.includes('topology')) return 'mongo-topology';
    if (lower.includes('connection')) return 'mongo-connection';
    if (lower.includes('collection')) {
        const name = (value as any)?.collectionName || (value as any)?.name;
        return name ? `mongo-collection(${name})` : 'mongo-collection';
    }
    if (lower.includes('db') && typeof (value as any).command === 'function') return 'mongo-db';
    return null;
}

function isMongooseDocumentLike(value: any): boolean {
    return !!value && typeof value === 'object' && typeof (value as any).toObject === 'function' && !!(value as any).$__;
}

function toPlainMongooseDoc(value: any): any | null {
    try {
        const plain = (value as any).toObject?.({ depopulate: true, virtuals: false, minimize: false, getters: false });
        if (plain && plain !== value) return plain;
    } catch {}
    try {
        const json = (value as any).toJSON?.();
        if (json && json !== value) return json;
    } catch {}
    return null;
}

function isMongooseQueryLike(value: any): boolean {
    return !!value && typeof value === 'object' && typeof (value as any).exec === 'function' && ((value as any).model || (value as any).op);
}

function summarizeMongooseQueryValue(value: any, depth: number, seen: WeakSet<object>) {
    try {
        const model = (value as any).model?.modelName || (value as any)._model?.modelName || undefined;
        const op = (value as any).op || (value as any).operation || (value as any).options?.op || undefined;
        return {
            __type: 'MongooseQuery',
            model,
            op,
            filter: sanitizeTraceValue((value as any).getFilter?.() ?? (value as any)._conditions, depth + 1, seen),
            update: sanitizeTraceValue((value as any).getUpdate?.() ?? (value as any)._update, depth + 1, seen),
            options: sanitizeTraceValue((value as any).getOptions?.() ?? (value as any).options, depth + 1, seen),
        };
    } catch {
        return 'mongo-query';
    }
}

function safeStringifyUnknown(value: any): string | undefined {
    try {
        const str = String(value);
        if (str === '[object Object]') return '[unserializable]';
        return str;
    } catch {
        return undefined;
    }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
    if (!Array.isArray(arr) || arr.length === 0) return [];
    if (!size || size <= 0) return [arr.slice()];

    const batches: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
        batches.push(arr.slice(i, i + size));
    }
    return batches;
}

function sanitizeTraceValue(value: any, depth = 0, seen: WeakSet<object> = new WeakSet()): any {
    if (value === null || value === undefined) return value;
    const type = typeof value;

    if (type === 'number' || type === 'boolean') return value;
    if (type === 'string') {
        if (value.length <= TRACE_VALUE_MAX_STRING) return value;
        return `${value.slice(0, TRACE_VALUE_MAX_STRING)}…(${value.length - TRACE_VALUE_MAX_STRING} more chars)`;
    }
    if (type === 'bigint') return value.toString();
    if (type === 'symbol') return value.toString();
    if (type === 'function') return `[Function${value.name ? ` ${value.name}` : ''}]`;

    const mongoId = coerceMongoId(value);
    if (mongoId !== null) return mongoId;

    if (isMongooseQueryLike(value)) {
        const captured = (value as any).__repro_result;
        if (captured !== undefined) {
            return sanitizeTraceValue(captured, depth + 1, seen);
        }
        return summarizeMongooseQueryValue(value, depth, seen);
    }

    const mongoPlaceholder = describeMongoPlaceholder(value);
    if (mongoPlaceholder) return mongoPlaceholder;

    if (isThenable(value)) {
        return { __type: 'Promise', state: 'pending' };
    }

    if (isMongooseDocumentLike(value)) {
        const plain = toPlainMongooseDoc(value);
        if (plain && plain !== value) {
            return sanitizeTraceValue(plain, depth, seen);
        }
    }

    if (Buffer.isBuffer(value)) {
        return {
            __type: 'Buffer',
            length: value.length,
            preview: value.length ? value.slice(0, 32).toString('hex') : '',
        };
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }

    if (type !== 'object') return String(value);

    if (!Array.isArray(value) && !(value instanceof Map) && !(value instanceof Set)) {
        const dehydrated = dehydrateComplexValue(value);
        if (dehydrated !== value) {
            return sanitizeTraceValue(dehydrated, depth, seen);
        }
    }

    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (depth >= TRACE_VALUE_MAX_DEPTH) {
        const shallow = safeJson(value);
        if (shallow !== undefined) {
            return shallow;
        }
        const ctor = value?.constructor?.name;
        return ctor && ctor !== 'Object'
            ? { __class: ctor, __truncated: `depth>${TRACE_VALUE_MAX_DEPTH}` }
            : { __truncated: `depth>${TRACE_VALUE_MAX_DEPTH}` };
    }

    if (Array.isArray(value)) {
        const out = value.slice(0, TRACE_VALUE_MAX_ITEMS)
            .map(item => sanitizeTraceValue(item, depth + 1, seen));
        if (value.length > TRACE_VALUE_MAX_ITEMS) {
            out.push(`…(${value.length - TRACE_VALUE_MAX_ITEMS} more items)`);
        }
        return out;
    }

    if (value instanceof Map) {
        const entries: Array<[any, any]> = [];
        for (const [k, v] of value) {
            if (entries.length >= TRACE_VALUE_MAX_ITEMS) break;
            entries.push([
                sanitizeTraceValue(k, depth + 1, seen),
                sanitizeTraceValue(v, depth + 1, seen)
            ]);
        }
        if (value.size > TRACE_VALUE_MAX_ITEMS) {
            entries.push([`…(${value.size - TRACE_VALUE_MAX_ITEMS} more entries)`, null]);
        }
        return { __type: 'Map', entries };
    }

    if (value instanceof Set) {
        const arr: any[] = [];
        for (const item of value) {
            if (arr.length >= TRACE_VALUE_MAX_ITEMS) break;
            arr.push(sanitizeTraceValue(item, depth + 1, seen));
        }
        if (value.size > TRACE_VALUE_MAX_ITEMS) {
            arr.push(`…(${value.size - TRACE_VALUE_MAX_ITEMS} more items)`);
        }
        return { __type: 'Set', values: arr };
    }

    const ctor = value?.constructor?.name;
    const result: Record<string, any> = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, TRACE_VALUE_MAX_KEYS)) {
        try {
            result[key] = sanitizeTraceValue((value as any)[key], depth + 1, seen);
        } catch (err) {
            result[key] = `[Cannot serialize: ${(err as Error)?.message || 'unknown error'}]`;
        }
    }
    if (keys.length > TRACE_VALUE_MAX_KEYS) {
        result.__truncatedKeys = keys.length - TRACE_VALUE_MAX_KEYS;
    }
    if (ctor && ctor !== 'Object') {
        result.__class = ctor;
    }
    return result;
}

function sanitizeTraceArgs(values: any): any {
    if (!Array.isArray(values)) return values;
    return values.map(v => sanitizeTraceValue(v));
}

function sanitizeRequestSnapshot(value: any) {
    if (value === undefined) return undefined;
    try {
        return sanitizeTraceValue(value);
    } catch {
        if (value === null) return null;
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            return value;
        }
        try { return JSON.parse(JSON.stringify(value)); } catch {}
        return safeStringifyUnknown(value);
    }
}

const DEFAULT_SENSITIVE_HEADERS: Array<string | RegExp> = [
    'authorization',
    'proxy-authorization',
    'authentication',
    'auth',
    'x-api-key',
    'api-key',
    'apikey',
    'x-api-token',
    'x-access-token',
    'x-auth-token',
    'x-id-token',
    'x-refresh-token',
    'id-token',
    'refresh-token',
    'cookie',
    'set-cookie',
];

function normalizeHeaderRules(rules?: HeaderRule | HeaderRule[] | null): HeaderRule[] {
    return normalizePatternArray<HeaderRule>(rules || []);
}

function matchesHeaderRule(name: string, rules: HeaderRule[]): boolean {
    if (!rules || !rules.length) return false;
    const lower = name.toLowerCase();
    return rules.some(rule => {
        if (rule instanceof RegExp) {
            try { return rule.test(name); } catch { return false; }
        }
        return lower === String(rule).toLowerCase();
    });
}

function normalizeHeaderCaptureConfig(raw?: boolean | HeaderCaptureOptions): NormalizedHeaderCapture {
    if (raw === false) {
        return { enabled: false, allowSensitive: false, drop: [], keep: [] };
    }
    const opts: HeaderCaptureOptions = raw && raw !== true ? raw : {};
    return {
        enabled: true,
        allowSensitive: opts.allowSensitiveHeaders === true,
        drop: normalizeHeaderRules(opts.dropHeaders),
        keep: normalizeHeaderRules(opts.keepHeaders),
    };
}

function sanitizeHeaderValue(value: any): any {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) {
        const arr = value.map(v => sanitizeHeaderValue(v)).filter(v => v !== undefined);
        return arr.length ? arr : undefined;
    }
    if (value === null) return null;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    const safe = safeJson(value);
    if (safe !== undefined) return safe;
    return safeStringifyUnknown(value);
}

function sanitizeHeaders(headers: any, rawCfg?: boolean | HeaderCaptureOptions) {
    const cfg = normalizeHeaderCaptureConfig(rawCfg);
    if (!cfg.enabled) return {};

    const dropList = cfg.allowSensitive ? cfg.drop : [...DEFAULT_SENSITIVE_HEADERS, ...cfg.drop];
    const out: Record<string, any> = {};

    for (const [rawKey, rawVal] of Object.entries(headers || {})) {
        const key = String(rawKey || '').toLowerCase();
        if (!key) continue;
        const shouldDrop = matchesHeaderRule(key, dropList);
        const keep = matchesHeaderRule(key, cfg.keep);
        if (shouldDrop && !keep) continue;

        const sanitizedValue = sanitizeHeaderValue(rawVal);
        if (sanitizedValue !== undefined) {
            out[key] = sanitizedValue;
        }
    }
    return out;
}

// ===================================================================
// reproMiddleware — unchanged behavior + passive per-request trace
// ===================================================================
export type ReproMiddlewareConfig = {
    appId: string;
    tenantId: string;
    appSecret: string;
    apiBase: string;
    /** Configure header capture/redaction. Defaults to capturing with sensitive headers removed. */
    captureHeaders?: boolean | HeaderCaptureOptions;
};

export function reproMiddleware(cfg: ReproMiddlewareConfig) {
    return function (req: Request, res: Response, next: NextFunction) {
        const sid = (req.headers['x-bug-session-id'] as string) || '';
        const aid = (req.headers['x-bug-action-id'] as string) || '';
        if (!sid || !aid) return next(); // only capture tagged requests

        const requestStartRaw = Date.now();
        const headerTs = readHeaderNumber(req.headers[REQUEST_START_HEADER]);
        const clockSkewMs = headerTs !== null ? headerTs - requestStartRaw : 0;
        const rid = String(headerTs !== null ? headerTs : requestStartRaw + clockSkewMs);
        const t0 = requestStartRaw;
        const url = (req as any).originalUrl || req.url || '/';
        const path = url; // back-compat
        const key = normalizeRouteKey(req.method, url);
        const requestHeaders = sanitizeHeaders(req.headers, cfg.captureHeaders);

        // ---- response body capture (unchanged) ----
        let capturedBody: any = undefined;
        const origJson = res.json.bind(res as any);
        (res as any).json = (body: any) => { capturedBody = body; return origJson(body); };

        const origSend = res.send.bind(res as any);
        (res as any).send = (body: any) => {
            if (capturedBody === undefined) {
                capturedBody = coerceBodyToStorable(body, res.getHeader?.('content-type'));
            }
            return origSend(body);
        };

        const origWrite = (res as any).write.bind(res as any);
        const origEnd = (res as any).end.bind(res as any);
        const chunks: Array<Buffer | string> = [];
        (res as any).write = (chunk: any, ...args: any[]) => { try { if (chunk != null) chunks.push(chunk); } catch {} return origWrite(chunk, ...args); };
        (res as any).end = (chunk?: any, ...args: any[]) => { try { if (chunk != null) chunks.push(chunk); } catch {} return origEnd(chunk, ...args); };

        // ---- our ALS (unchanged) ----
        const tracerApiWithTrace = __TRACER__ as (TracerApi & { withTrace?: (id: string, fn: () => void) => void }) | null;
        const runInTrace = (fn: () => void) => {
            if (tracerApiWithTrace?.withTrace) {
                return tracerApiWithTrace.withTrace(rid, fn);
            }
            return fn();
        };

        runInTrace(() => als.run({ sid, aid, clockSkewMs }, () => {
            const events: TraceEventRecord[] = [];
            let endpointTrace: EndpointTraceInfo | null = null;
            let preferredAppTrace: EndpointTraceInfo | null = null;
            let firstAppTrace: EndpointTraceInfo | null = null;
            let unsubscribe: undefined | (() => void);
            let flushed = false;
            let finished = false;
            let idleTimer: NodeJS.Timeout | null = null;
            let hardStopTimer: NodeJS.Timeout | null = null;
            let flushPayload: null | (() => void) = null;

            const clearTimers = () => {
                if (idleTimer) {
                    try { clearTimeout(idleTimer); } catch {}
                    idleTimer = null;
                }
                if (hardStopTimer) {
                    try { clearTimeout(hardStopTimer); } catch {}
                    hardStopTimer = null;
                }
            };

            const doFlush = () => {
                if (flushed) return;
                flushed = true;
                clearTimers();
                try { unsubscribe && unsubscribe(); } catch {}
                try { flushPayload?.(); } catch {}
            };

            const bumpIdle = () => {
                if (!finished || flushed) return;
                if (idleTimer) {
                    try { clearTimeout(idleTimer); } catch {}
                }
                idleTimer = setTimeout(doFlush, TRACE_IDLE_FLUSH_MS);
            };

            try {
                if (__TRACER__?.tracer?.on) {
                    const getTid = __TRACER__?.getCurrentTraceId;
                    const tidNow = getTid ? getTid() : null;
                    if (tidNow) {
                        unsubscribe = __TRACER__.tracer.on((ev: any) => {
                            if (!ev || ev.traceId !== tidNow) return;

                            const evt: TraceEventRecord = {
                                t: alignTimestamp(ev.t),
                                type: ev.type,
                                fn: ev.fn,
                                file: ev.file,
                                line: ev.line,
                                depth: ev.depth,
                                spanId: ev.spanId ?? null,
                                parentSpanId: ev.parentSpanId ?? null,
                            };

                            if (ev.functionType !== undefined) {
                                evt.functionType = ev.functionType;
                            }

                            if (ev.args !== undefined) {
                                evt.args = sanitizeTraceArgs(ev.args);
                            }
                            if (ev.returnValue !== undefined) {
                                evt.returnValue = sanitizeTraceValue(ev.returnValue);
                            }
                            if (ev.error !== undefined) {
                                evt.error = sanitizeTraceValue(ev.error);
                            }
                            if (ev.threw !== undefined) {
                                evt.threw = Boolean(ev.threw);
                            }
                            if (ev.unawaited !== undefined) {
                                evt.unawaited = ev.unawaited === true;
                            }

                            const candidate: TraceEventForFilter = {
                                type: evt.type,
                                eventType: evt.type,
                                functionType: evt.functionType ?? null,
                                fn: evt.fn,
                                file: evt.file ?? null,
                                depth: evt.depth,
                                library: inferLibraryNameFromFile(evt.file),
                            };

                            if (shouldDropTraceEvent(candidate)) {
                                return;
                            }

                            if (evt.type === 'enter' && isLikelyAppFile(evt.file)) {
                                const depthOk = evt.depth === undefined || evt.depth <= 6;
                                const trace = toEndpointTrace(evt);

                                if (depthOk && !firstAppTrace) {
                                    firstAppTrace = trace;
                                }

                                if (isLikelyNestControllerFile(evt.file)) {
                                    endpointTrace = trace;
                                } else if (depthOk && !preferredAppTrace && !isLikelyNestGuardFile(evt.file)) {
                                    preferredAppTrace = trace;
                                }
                            }

                            events.push(evt);
                            bumpIdle();
                        });
                    }
                }
            } catch { /* never break user code */ }

            res.on('finish', () => {
                finished = true;
                if (capturedBody === undefined && chunks.length) {
                    const buf = Buffer.isBuffer(chunks[0])
                        ? Buffer.concat(chunks.map(c => (Buffer.isBuffer(c) ? c : Buffer.from(String(c)))))
                        : Buffer.from(chunks.map(String).join(''));
                    capturedBody = coerceBodyToStorable(buf, res.getHeader?.('content-type'));
                }

                flushPayload = () => {
                    const balancedEvents = reorderTraceEvents(balanceTraceEvents(events.slice()));
                    const summary = summarizeEndpointFromEvents(balancedEvents);
                    const chosenEndpoint = summary.endpointTrace
                        ?? summary.preferredAppTrace
                        ?? summary.firstAppTrace
                        ?? endpointTrace
                        ?? preferredAppTrace
                        ?? firstAppTrace
                        ?? { fn: null, file: null, line: null, functionType: null };
                    const traceBatches = chunkArray(balancedEvents, TRACE_BATCH_SIZE);
                    const requestBody = sanitizeRequestSnapshot((req as any).body);
                    const requestParams = sanitizeRequestSnapshot((req as any).params);
                    const requestQuery = sanitizeRequestSnapshot((req as any).query);

                    const requestPayload: Record<string, any> = {
                        rid,
                        method: req.method,
                        url,
                        path,
                        status: res.statusCode,
                        durMs: Date.now() - t0,
                        headers: requestHeaders,
                        key,
                        respBody: capturedBody,
                        trace: traceBatches.length ? undefined : '[]',
                    };
                    if (requestBody !== undefined) requestPayload.body = requestBody;
                    if (requestParams !== undefined) requestPayload.params = requestParams;
                    if (requestQuery !== undefined) requestPayload.query = requestQuery;
                    requestPayload.entryPoint = chosenEndpoint;

                    post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, sid, {
                        entries: [{
                            actionId: aid,
                            request: requestPayload,
                            t: alignedNow(),
                        }]
                    });

                    if (traceBatches.length) {
                        for (let i = 0; i < traceBatches.length; i++) {
                            const batch = traceBatches[i];
                            let traceStr = '[]';
                            try { traceStr = JSON.stringify(batch); } catch {}

                            post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, sid, {
                                entries: [{
                                    actionId: aid,
                                    trace: traceStr,
                                    traceBatch: {
                                        rid,
                                        index: i,
                                        total: traceBatches.length,
                                    },
                                    t: alignedNow(),
                                }],
                            });
                        }
                    }
                };

                if (__TRACER_READY) {
                    bumpIdle();
                    const hardDeadlineMs = Math.max(
                        0,
                        Math.max(TRACE_LINGER_AFTER_FINISH_MS, TRACE_IDLE_FLUSH_MS) + TRACE_FLUSH_DELAY_MS,
                    );
                    hardStopTimer = setTimeout(doFlush, hardDeadlineMs);
                } else {
                    doFlush();
                }
            });

            next();
        }));
    };
}

// ===================================================================
// reproMongoosePlugin — stable + NON-intrusive query logs
//   - NO prototype monkey-patching of Mongoose
//   - ONLY schema middleware (pre/post) for specific ops
//   - keeps your existing doc-diff hooks
// ===================================================================
export function reproMongoosePlugin(cfg: { appId: string; tenantId: string; appSecret: string; apiBase: string }) {
    return function (schema: Schema) {
        // -------- pre/post save (unchanged) --------
        schema.pre('save', { document: true }, async function (next) {
            const { sid, aid } = getCtx();
            if (!sid || !aid) return next();
            if ((this as any).$isSubdocument) return next();

            let before: any = null;
            try {
                if (!this.isNew) {
                    const model = this.constructor as Model<any>;
                    before = await model.findById(this._id).lean().exec();
                }
            } catch {}
            (this as any).__repro_meta = {
                wasNew: this.isNew,
                before,
                collection: resolveCollectionOrWarn(this, 'doc'),
            };
            next();
        });

        schema.post('save', { document: true }, function () {
            const { sid, aid } = getCtx();
            if (!sid || !aid) return;
            if ((this as any).$isSubdocument) return;

            const meta = (this as any).__repro_meta || {};
            const before = meta.before ?? null;
            const after = this.toObject({ depopulate: true });
            const collection = meta.collection || resolveCollectionOrWarn(this, 'doc');

            const query = meta.wasNew
                ? { op: 'insertOne', doc: after }
                : { filter: { _id: this._id }, update: buildMinimalUpdate(before, after), options: { upsert: false } };

            post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, (getCtx() as Ctx).sid!, {
                entries: [{
                    actionId: (getCtx() as Ctx).aid!,
                    db: [{ collection, pk: { _id: (this as any)._id }, before, after, op: meta.wasNew ? 'insert' : 'update', query }],
                    t: alignedNow(),
                }]
            });
        });

        // -------- findOneAndUpdate capture (unchanged) --------
        schema.pre<Query<any, any>>('findOneAndUpdate', async function (next) {
            const { sid, aid } = getCtx();
            if (!sid || !aid) return next();
            try {
                const filter = this.getFilter();
                const model = this.model as Model<any>;
                (this as any).__repro_before = await model.findOne(filter).lean().exec();
                this.setOptions({ new: true });
                (this as any).__repro_collection = resolveCollectionOrWarn(this, 'query');
            } catch {}
            next();
        });

        schema.post<Query<any, any>>('findOneAndUpdate', function (res: any) {
            const { sid, aid } = getCtx();
            if (!sid || !aid) return;

            const before = (this as any).__repro_before ?? null;
            const after = res ?? null;
            const collection = (this as any).__repro_collection || resolveCollectionOrWarn(this, 'query');
            const pk = after?._id ?? before?._id;

            post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, (getCtx() as Ctx).sid!, {
                entries: [{
                    actionId: (getCtx() as Ctx).aid!,
                    db: [{ collection, pk: { _id: pk }, before, after, op: after && before ? 'update' : after ? 'insert' : 'update' }],
                    t: alignedNow()
                }]
            });
        });

        // -------- deleteOne capture (unchanged) --------
        schema.pre<Query<any, any>>('deleteOne', { document: false, query: true }, async function (next) {
            const { sid, aid } = getCtx(); if (!sid || !aid) return next();
            try {
                const filter = this.getFilter();
                (this as any).__repro_before = await (this.model as Model<any>).findOne(filter).lean().exec();
                (this as any).__repro_collection = resolveCollectionOrWarn(this, 'query');
                (this as any).__repro_filter = filter;
            } catch {}
            next();
        });

        schema.post<Query<any, any>>('deleteOne', { document: false, query: true }, function () {
            const { sid, aid } = getCtx(); if (!sid || !aid) return;
            const before = (this as any).__repro_before ?? null;
            if (!before) return;
            const collection = (this as any).__repro_collection || resolveCollectionOrWarn(this, 'query');
            const filter = (this as any).__repro_filter ?? { _id: before._id };
            post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, (getCtx() as Ctx).sid!, {
                entries: [{
                    actionId: (getCtx() as Ctx).aid!,
                    db: [{ collection, pk: { _id: before._id }, before, after: null, op: 'delete', query: { filter } }],
                    t: alignedNow()
                }]
            });
        });

        // -------- NON-intrusive generic query telemetry via schema hooks -------
        const sanitizeDbValue = (value: any) => {
            const sanitized = sanitizeTraceValue(value);
            return sanitized === undefined ? undefined : sanitized;
        };

        const READ_OPS = [
            'find',
            'findOne',
            'countDocuments',
            'estimatedDocumentCount',
            'distinct',
        ] as const;

        const WRITE_OPS = [
            'updateOne',
            'updateMany',
            'replaceOne',
            'deleteMany',
            'findOneAndUpdate',
            'findOneAndDelete',
            'findOneAndRemove',
            'findOneAndReplace',
            'findByIdAndUpdate',
            'findByIdAndDelete',
            'findByIdAndRemove',
            'findByIdAndReplace',
        ] as const;

        function attachQueryHooks(op: string) {
            schema.pre(op as any, function (this: any, next: Function) {
                try {
                    (this as any).__repro_qmeta = {
                        t0: Date.now(),
                        collection: this?.model?.collection?.name || 'unknown',
                        op,
                        filter: sanitizeDbValue(this.getFilter?.() ?? this._conditions ?? undefined),
                        update: sanitizeDbValue(this.getUpdate?.() ?? this._update ?? undefined),
                        projection: sanitizeDbValue(this.projection?.() ?? this._fields ?? undefined),
                        options: sanitizeDbValue(this.getOptions?.() ?? this.options ?? undefined),
                    };
                } catch {
                    (this as any).__repro_qmeta = { t0: Date.now(), collection: 'unknown', op };
                }
                next();
            });

            schema.post(op as any, function (this: any, res: any) {
                const { sid, aid } = getCtx();
                if (!sid) return;

                const meta = (this as any).__repro_qmeta || { t0: Date.now(), collection: 'unknown', op };
                const resultMeta = summarizeQueryResult(op, res);

                emitDbQuery(cfg, sid, aid, {
                    collection: meta.collection,
                    op,
                    query: { filter: meta.filter, update: meta.update, projection: meta.projection, options: meta.options },
                    resultMeta,
                    durMs: Date.now() - meta.t0,
                    t: alignedNow(),
                });
            });
        }

        READ_OPS.forEach(attachQueryHooks);
        WRITE_OPS.forEach(attachQueryHooks);

        // bulkWrite + insertMany (non-query middleware)
        schema.pre<any>('insertMany' as any, { document: false, query: false } as any, function (this: any, next: Function, docs?: any[]) {
            try {
                (this as any).__repro_insert_meta = {
                    t0: Date.now(),
                    collection: this?.collection?.name || this?.model?.collection?.name || 'unknown',
                    docs: sanitizeDbValue(docs),
                };
            } catch {
                (this as any).__repro_insert_meta = { t0: Date.now(), collection: 'unknown' };
            }
            next();
        } as any);

        schema.post<any>('insertMany' as any, { document: false, query: false } as any, function (this: any, docs: any[]) {
            const { sid, aid } = getCtx();
            if (!sid) return;
            const meta = (this as any).__repro_insert_meta || { t0: Date.now(), collection: 'unknown' };
            const resultMeta = Array.isArray(docs) ? { inserted: docs.length } : summarizeQueryResult('insertMany', docs);

            emitDbQuery(cfg, sid, aid, {
                collection: meta.collection,
                op: 'insertMany',
                query: { docs: meta.docs ?? undefined },
                resultMeta,
                durMs: Date.now() - meta.t0,
                t: alignedNow(),
            });
        } as any);

        schema.pre<any>('bulkWrite' as any, { document: false, query: false } as any, function (this: any, next: Function, ops?: any[]) {
            try {
                (this as any).__repro_bulk_meta = {
                    t0: Date.now(),
                    collection: this?.collection?.name || this?.model?.collection?.name || 'unknown',
                    ops: sanitizeDbValue(ops),
                };
            } catch {
                (this as any).__repro_bulk_meta = { t0: Date.now(), collection: 'unknown' };
            }
            next();
        } as any);

        schema.post<any>('bulkWrite' as any, { document: false, query: false } as any, function (this: any, res: any) {
            const { sid, aid } = getCtx();
            if (!sid) return;
            const meta = (this as any).__repro_bulk_meta || { t0: Date.now(), collection: 'unknown' };
            const bulkResult = summarizeBulkResult(res);
            const resultMeta = { ...bulkResult, result: sanitizeResultForMeta(res?.result ?? res) };

            emitDbQuery(cfg, sid, aid, {
                collection: meta.collection,
                op: 'bulkWrite',
                query: { ops: meta.ops ?? undefined },
                resultMeta,
                durMs: Date.now() - meta.t0,
                t: alignedNow(),
            });
        } as any);

        // Aggregate middleware (non-intrusive)
        schema.pre('aggregate', function (this: any, next: Function) {
            try {
                (this as any).__repro_aggmeta = {
                    t0: Date.now(),
                    collection:
                        this?.model?.collection?.name ||
                        this?._model?.collection?.name ||
                        (this?.model && this.model.collection?.name) ||
                        'unknown',
                    pipeline: sanitizeDbValue(this.pipeline?.() ?? this._pipeline ?? undefined),
                };
            } catch {
                (this as any).__repro_aggmeta = { t0: Date.now(), collection: 'unknown', pipeline: undefined };
            }
            next();
        });

        schema.post('aggregate', function (this: any, res: any[]) {
            const { sid, aid } = getCtx();
            if (!sid) return;

            const meta = (this as any).__repro_aggmeta || { t0: Date.now(), collection: 'unknown' };
            const resultMeta = summarizeQueryResult('aggregate', res);

            emitDbQuery(cfg, sid, aid, {
                collection: meta.collection,
                op: 'aggregate',
                query: { pipeline: meta.pipeline },
                resultMeta,
                durMs: Date.now() - meta.t0,
                t: alignedNow(),
            });
        });
    };
}

function summarizeQueryResult(op: string, res: any) {
    const resultPreview = sanitizeResultForMeta(res);

    if (
        op === 'find' ||
        op === 'findOne' ||
        op === 'aggregate' ||
        op === 'distinct' ||
        op.startsWith('count')
    ) {
        const summary: Record<string, any> = {};
        if (Array.isArray(res)) summary.docsCount = res.length;
        else if (res && typeof res === 'object' && typeof (res as any).toArray === 'function') summary.docsCount = undefined;
        else if (res == null) summary.docsCount = 0;
        else summary.docsCount = 1;

        if (typeof resultPreview !== 'undefined') {
            summary.result = resultPreview;
        }
        return summary;
    }

    if (op === 'insertMany') {
        const summary: Record<string, any> = {};
        if (Array.isArray(res)) summary.inserted = res.length;
        if (typeof resultPreview !== 'undefined') summary.result = resultPreview;
        return summary;
    }

    if (op === 'bulkWrite') {
        return { ...summarizeBulkResult(res), result: resultPreview };
    }

    const stats = pickWriteStats(res);
    if (typeof resultPreview !== 'undefined') {
        return { ...stats, result: resultPreview };
    }
    return stats;
}

function summarizeBulkResult(res: any) {
    return {
        matched: res?.matchedCount ?? res?.nMatched ?? undefined,
        modified: res?.modifiedCount ?? res?.nModified ?? undefined,
        upserted: res?.upsertedCount ?? undefined,
        deleted: res?.deletedCount ?? undefined,
    };
}

function pickWriteStats(r: any) {
    return {
        matched: r?.matchedCount ?? r?.n ?? r?.nMatched ?? undefined,
        modified: r?.modifiedCount ?? r?.nModified ?? undefined,
        upsertedId: r?.upsertedId ?? r?.upserted?._id ?? undefined,
        deleted: r?.deletedCount ?? undefined,
    };
}

function safeJson(v: any) {
    try { return v == null ? undefined : JSON.parse(JSON.stringify(v)); } catch { return undefined; }
}

function sanitizeResultForMeta(value: any) {
    if (value === undefined) return undefined;
    if (typeof value === 'function') return undefined;
    try {
        return sanitizeTraceValue(value);
    } catch {
        const fallback = safeJson(value);
        return fallback === undefined ? undefined : fallback;
    }
}

function dehydrateComplexValue(value: any) {
    if (!value || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value;
    if (value instanceof Date || value instanceof RegExp || Buffer.isBuffer(value)) return value;
    if (value instanceof Map || value instanceof Set) return value;

    try {
        if (typeof (value as any).toJSON === 'function') {
            const plain = (value as any).toJSON();
            if (plain && plain !== value) return plain;
        }
    } catch {}

    try {
        if (typeof (value as any).toObject === 'function') {
            const plain = (value as any).toObject();
            if (plain && plain !== value) return plain;
        }
    } catch {}

    const ctor = (value as any)?.constructor?.name;
    if (ctor && ctor !== 'Object') {
        const plain = safeJson(value);
        if (plain !== undefined) return plain;
    }

    return value;
}

function emitDbQuery(cfg: any, sid?: string, aid?: string, payload?: any) {
    if (!sid) return;
    post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, sid, {
        entries: [{
            actionId: aid ?? null,
            db: [{
                collection: payload.collection,
                op: payload.op,
                query: payload.query ?? undefined,
                resultMeta: payload.resultMeta ?? undefined,
                durMs: payload.durMs ?? undefined,
                pk: null, before: null, after: null,
                error: payload.error ?? undefined,
            }],
            t: payload.t,
        }]
    });
}

function buildMinimalUpdate(before: any, after: any) {
    const set: Record<string, any> = {};
    const unset: Record<string, any> = {};

    function walk(b: any, a: any, path = '') {
        const bKeys = b ? Object.keys(b) : [];
        const aKeys = a ? Object.keys(a) : [];
        const all = new Set([...bKeys, ...aKeys]);
        for (const k of all) {
            const p = path ? `${path}.${k}` : k;
            const bv = b?.[k];
            const av = a?.[k];

            const bothObj =
                bv && av &&
                typeof bv === 'object' &&
                typeof av === 'object' &&
                !Array.isArray(bv) &&
                !Array.isArray(av);

            if (bothObj) {
                walk(bv, av, p);
            } else if (typeof av === 'undefined') {
                unset[p] = '';
            } else if (JSON.stringify(bv) !== JSON.stringify(av)) {
                set[p] = av;
            }
        }
    }

    walk(before || {}, after || {});
    const update: any = {};
    if (Object.keys(set).length) update.$set = set;
    if (Object.keys(unset).length) update.$unset = unset;
    return update;
}

// ===================================================================
// Sendgrid — unchanged
// ===================================================================
export type SendgridPatchConfig = {
    appId: string;
    tenantId: string;
    appSecret: string;
    apiBase: string;
    resolveContext?: () => { sid?: string; aid?: string } | undefined;
};

export function patchSendgridMail(cfg: SendgridPatchConfig) {
    let sgMail: any;
    try { sgMail = require('@sendgrid/mail'); } catch { return; } // no-op if not installed

    if (!sgMail || (sgMail as any).__repro_patched) return;
    (sgMail as any).__repro_patched = true;

    const origSend = sgMail.send?.bind(sgMail);
    const origSendMultiple = sgMail.sendMultiple?.bind(sgMail);

    if (origSend) {
        sgMail.send = async function patchedSend(msg: any, isMultiple?: boolean) {
            const t0 = Date.now();
            let statusCode: number | undefined;
            let headers: Record<string, any> | undefined;
            try {
                const res = await origSend(msg, isMultiple);
                const r = Array.isArray(res) ? res[0] : res;
                statusCode = r?.statusCode ?? r?.status;
                headers = r?.headers ?? undefined;
                return res;
            } finally {
                fireCapture('send', msg, t0, statusCode, headers);
            }
        };
    }

    if (origSendMultiple) {
        sgMail.sendMultiple = async function patchedSendMultiple(msg: any) {
            const t0 = Date.now();
            let statusCode: number | undefined;
            let headers: Record<string, any> | undefined;
            try {
                const res = await origSendMultiple(msg);
                const r = Array.isArray(res) ? res[0] : res;
                statusCode = r?.statusCode ?? r?.status;
                headers = r?.headers ?? undefined;
                return res;
            } finally {
                fireCapture('sendMultiple', msg, t0, statusCode, headers);
            }
        };
    }

    function fireCapture(kind: 'send' | 'sendMultiple', rawMsg: any, t0: number, statusCode?: number, headers?: any) {
        const ctx = getCtx();
        const sid = ctx.sid ?? cfg.resolveContext?.()?.sid;
        const aid = ctx.aid ?? cfg.resolveContext?.()?.aid;
        if (!sid) return;

        const norm = normalizeSendgridMessage(rawMsg);
        post(cfg.apiBase, cfg.tenantId, cfg.appId, cfg.appSecret, sid, {
            entries: [{
                actionId: aid ?? null,
                email: {
                    provider: 'sendgrid',
                    kind,
                    to: norm.to, cc: norm.cc, bcc: norm.bcc, from: norm.from,
                    subject: norm.subject, text: norm.text, html: norm.html,
                    templateId: norm.templateId, dynamicTemplateData: norm.dynamicTemplateData,
                    categories: norm.categories, customArgs: norm.customArgs,
                    attachmentsMeta: norm.attachmentsMeta,
                    statusCode, durMs: Date.now() - t0, headers: headers ?? {},
                },
                t: alignedNow(),
            }]
        });
    }

    function normalizeAddress(a: any): { email: string; name?: string } | null {
        if (!a) return null;
        if (typeof a === 'string') return { email: a };
        if (typeof a === 'object' && a.email) return { email: String(a.email), name: a.name ? String(a.name) : undefined };
        return null;
    }
    function normalizeAddressList(v: any) {
        if (!v) return undefined;
        const arr = Array.isArray(v) ? v : [v];
        const out = arr.map(normalizeAddress).filter(Boolean) as Array<{ email: string; name?: string }>;
        return out.length ? out : undefined;
    }
    function normalizeSendgridMessage(msg: any) {
        const base = {
            from: normalizeAddress(msg?.from) ?? undefined,
            to: normalizeAddressList(msg?.to),
            cc: normalizeAddressList(msg?.cc),
            bcc: normalizeAddressList(msg?.bcc),
            subject: msg?.subject ? String(msg.subject) : undefined,
            text: typeof msg?.text === 'string' ? msg.text : undefined,
            html: typeof msg?.html === 'string' ? msg.html : undefined,
            templateId: msg?.templateId ? String(msg.templateId) : undefined,
            dynamicTemplateData: msg?.dynamic_template_data ?? msg?.dynamicTemplateData ?? undefined,
            categories: Array.isArray(msg?.categories) ? msg.categories.map(String) : undefined,
            customArgs: msg?.customArgs ?? msg?.custom_args ?? undefined,
            attachmentsMeta: Array.isArray(msg?.attachments)
                ? msg.attachments.map((a: any) => ({
                    filename: a?.filename ? String(a.filename) : undefined,
                    type: a?.type ? String(a.type) : undefined,
                    size: a?.content ? byteLen(a.content) : undefined,
                }))
                : undefined,
        };
        const p0 = Array.isArray(msg?.personalizations) ? msg.personalizations[0] : undefined;
        if (p0) {
            base.to = normalizeAddressList(p0.to) ?? base.to;
            base.cc = normalizeAddressList(p0.cc) ?? base.cc;
            base.bcc = normalizeAddressList(p0.bcc) ?? base.bcc;
            if (!base.subject && p0.subject) base.subject = String(p0.subject);
            if (!base.dynamicTemplateData && (p0 as any).dynamic_template_data) base.dynamicTemplateData = (p0 as any).dynamic_template_data;
            if (!base.customArgs && (p0 as any).custom_args) base.customArgs = (p0 as any).custom_args;
        }
        return base;
    }
    function byteLen(content: any): number | undefined {
        try {
            if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
            if (content && typeof content === 'object' && 'length' in content) return Number((content as any).length);
        } catch {}
        return undefined;
    }
}
