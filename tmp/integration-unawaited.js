// Integration test: unawaited async function traced through reproMiddleware + tracer.
// Uses actual SDK middleware + tracer runtime, stubbing network posts.
const assert = require('assert');
const { EventEmitter } = require('events');
const { initReproTracing, reproMiddleware } = require('../dist');
const { trace } = require('../tracer/runtime');

// Stub fetch to capture payloads sent by SDK (no real network).
global.fetch = async (url, opts = {}) => {
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

// Fake services and functions that mirror user scenario.
const studyConfigService = {
    findNotificationModule: async (protocolId) => ({ id: protocolId, cfg: 'notif' }),
    loadStudyModuleConfig: async (protocolId) => ({ id: protocolId, cfg: 'study' }),
    loadStudyConfigUserModule: async (protocolId) => ({ id: protocolId, cfg: 'user' }),
};

const notifyAboutShipmentDispatch = async function notifyAboutShipmentDispatch(protocolId) {
    const notificationConfig = await global.__repro_call(
        studyConfigService.findNotificationModule,
        studyConfigService,
        [protocolId],
        'app',
        10,
        'findNotificationModule',
        false
    );
    const studyModuleConfig = await global.__repro_call(
        studyConfigService.loadStudyModuleConfig,
        studyConfigService,
        [protocolId],
        'app',
        11,
        'loadStudyModuleConfig',
        false
    );
    const userModuleConfig = await global.__repro_call(
        studyConfigService.loadStudyConfigUserModule,
        studyConfigService,
        [protocolId],
        'app',
        12,
        'loadStudyConfigUserModule',
        false
    );
    return { notificationConfig, studyModuleConfig, userModuleConfig };
};

const handleNotificationError = async function handleNotificationError(promise) {
    try { await promise; } catch (err) { return { error: String(err) }; }
    return { ok: true };
};

async function main() {
    // Init tracer before defining app so ALS is ready.
    initReproTracing({ instrument: false, logFunctionCalls: false });

    const middleware = reproMiddleware({
        appId: 'app',
        tenantId: 'tenant',
        appSecret: 'secret',
        captureHeaders: false,
    });
    const handler = middleware;

    const req = new EventEmitter();
    req.method = 'POST';
    req.url = '/notify';
    req.headers = {
        'content-type': 'application/json',
        'x-bug-session-id': 'sid',
        'x-bug-action-id': 'aid',
        'x-bug-request-start': String(Date.now()),
    };
    req.body = { protocolId: 'proto-123' };
    const rid = req.headers['x-bug-request-start'];

    const emitted = [];
    const unsub = trace.on(ev => { emitted.push(ev); });

    const res = new EventEmitter();
    res.statusCode = 200;
    res.getHeader = () => undefined;
    res.json = function (body) { this.body = body; this.emit('finish'); return body; };
    res.send = function (body) { this.body = body; this.emit('finish'); return body; };
    res.write = function () { return true; };
    res.end = function () { this.emit('finish'); return true; };

    const route = async () => {
        const protocolId = String((req.body && req.body.protocolId) || 'p1');
        const p = global.__repro_call(
            notifyAboutShipmentDispatch,
            null,
            [protocolId],
            'app',
            1,
            'notifyAboutShipmentDispatch',
            true // mark unawaited
        );
        handleNotificationError(p); // fire-and-forget
        const snapshot = await studyConfigService.findNotificationModule(protocolId);
        res.json({ ok: true, snapshot });
    };

    await new Promise((resolve, reject) => {
        handler(req, res, async () => {
            try { await route(); resolve(); } catch (err) { reject(err); }
        });
    });

    await new Promise(r => setTimeout(r, 80)); // allow flush
    unsub();

    // Rebuild parent/child ordering similar to SDK reorder.
    const interestingFns = new Set([
        'notifyAboutShipmentDispatch',
        'findNotificationModule',
        'loadStudyModuleConfig',
        'loadStudyConfigUserModule'
    ]);
    const filtered = emitted.filter(ev => interestingFns.has(ev.fn));

    const normalizeId = v => (v === null || v === undefined ? null : String(v));
    const nodes = new Map();
    const roots = [];
    filtered.forEach((ev, idx) => {
        const sid = normalizeId(ev.spanId);
        const pid = normalizeId(ev.parentSpanId);
        if (!sid) {
            roots.push({ order: idx, ev });
            return;
        }
        let node = nodes.get(sid);
        if (!node) {
            node = { id: sid, parentId: pid, enter: null, exit: null, children: [], order: idx };
            nodes.set(sid, node);
        }
        node.parentId = pid;
        node.order = Math.min(node.order, idx);
        if (ev.type === 'enter' && !node.enter) node.enter = ev;
        if (ev.type === 'exit') node.exit = ev;
    });

    nodes.forEach(node => {
        if (node.parentId && nodes.has(node.parentId)) {
            nodes.get(node.parentId).children.push(node);
        } else {
            roots.push(node);
        }
    });
    nodes.forEach(node => node.children.sort((a, b) => a.order - b.order));
    roots.sort((a, b) => a.order - b.order);

    const ordered = [];
    const emitNode = n => {
        if (n.enter) ordered.push(n.enter);
        n.children.forEach(emitNode);
        if (n.exit) ordered.push(n.exit);
    };
    roots.forEach(r => {
        if (r.ev) ordered.push(r.ev); else emitNode(r);
    });

    const seq = ordered.map(ev => `${ev.type}:${ev.fn}`);
    const expected = [
        'enter:notifyAboutShipmentDispatch',
        'enter:findNotificationModule',
        'exit:findNotificationModule',
        'enter:loadStudyModuleConfig',
        'exit:loadStudyModuleConfig',
        'enter:loadStudyConfigUserModule',
        'exit:loadStudyConfigUserModule',
        'exit:notifyAboutShipmentDispatch',
    ];
    assert.deepStrictEqual(seq, expected, `Trace order mismatch.\nGot: ${seq.join(' | ')}\nExpected: ${expected.join(' | ')}`);
    console.log('integration unawaited trace OK');
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
