// Integration-style sanity check for unawaited async call ordering.
const assert = require('assert');
const { trace, SYM_IS_APP } = require('../tracer/runtime');

function wrapFunction(name, fn, opts = {}) {
    const { bodyTraced = false } = opts;
    const wrapped = function wrappedFn(...args) {
        trace.enter(name, { file: 'app', line: 1 });
        let result;
        let err = null;
        let threw = false;
        try {
            result = fn.apply(this, args);
            return result;
        } catch (e) {
            threw = true;
            err = e;
            throw e;
        } finally {
            trace.exit({ fn: name, file: 'app', line: 1 }, { returnValue: result, error: err, threw });
        }
    };
    try {
        wrapped[SYM_IS_APP] = true;
        wrapped.__repro_instrumented = true;
        if (bodyTraced) wrapped.__repro_body_traced = true;
    } catch {}
    return wrapped;
}

async function testUnawaitedOrdering() {
    const events = [];
    const unsubscribe = trace.on(ev => { if (ev && ev.traceId) events.push(ev); });

    // Mock inner async functions.
    const findNotificationModule = wrapFunction('findNotificationModule', async () => 'config');
    const loadStudyModuleConfig = wrapFunction('loadStudyModuleConfig', async () => 'studyConfig');
    const loadStudyConfigUserModule = wrapFunction('loadStudyConfigUserModule', async () => 'userConfig');

    const notifyAboutShipmentDispatch = wrapFunction('notifyAboutShipmentDispatch', async () => {
        await findNotificationModule();
        await loadStudyModuleConfig();
        await loadStudyConfigUserModule();
        return 'done';
    }, { bodyTraced: true });

    await trace.withTrace('t1', async () => {
        const p = global.__repro_call(
            notifyAboutShipmentDispatch,
            null,
            [],
            'app',
            1,
            'notifyAboutShipmentDispatch',
            true // mark unawaited
        );
        // Simulate unawaited usage, but wait so events flush.
        await p.catch(() => {});
    });

    unsubscribe();

    const ordered = events.map(ev => `${ev.type}:${ev.fn}`);
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

    assert.deepStrictEqual(ordered, expected, `Trace order mismatch.\nGot: ${ordered.join(' | ')}\nExpected: ${expected.join(' | ')}`);
    console.log('unawaited async trace order OK');
}

async function testUnawaitedSiblingParenting() {
    const events = [];
    const off = trace.on(ev => { if (ev && ev.traceId === 't2') events.push(ev); });

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    const unawaitedChild = wrapFunction('unawaitedChild', async () => {
        await wait(5);
        return 'child';
    });
    const siblingWork = wrapFunction('siblingWork', async () => {
        await wait(1);
        return 'sibling';
    });
    const parent = wrapFunction('parent', async () => {
        const childPromise = global.__repro_call(
            unawaitedChild,
            null,
            [],
            'app',
            21,
            'unawaitedChild',
            true
        );
        await global.__repro_call(
            siblingWork,
            null,
            [],
            'app',
            22,
            'siblingWork',
            false
        );
        return { childPromise };
    });

    const { childPromise } = await trace.withTrace('t2', async () => parent());
    await childPromise.catch(() => {});
    await wait(5);
    off();

    const enterByFn = {};
    const exitByFn = {};
    events.forEach(ev => {
        if (!ev || !ev.fn) return;
        if (ev.type === 'enter' && !enterByFn[ev.fn]) enterByFn[ev.fn] = ev;
        if (ev.type === 'exit' && !exitByFn[ev.fn]) exitByFn[ev.fn] = ev;
    });

    const parentEnter = enterByFn.parent;
    const childEnter = enterByFn.unawaitedChild;
    const siblingEnter = enterByFn.siblingWork;
    assert(parentEnter && childEnter && siblingEnter, 'Missing enter events for parent/child/sibling');

    assert.strictEqual(
        childEnter.parentSpanId,
        parentEnter.spanId,
        'Unawaited child should be parented to the caller span'
    );
    assert.strictEqual(
        siblingEnter.parentSpanId,
        parentEnter.spanId,
        'Sibling after unawaited call should not inherit unawaited child as parent'
    );

    const parentExit = exitByFn.parent;
    assert(parentExit, 'Missing exit event for parent');
    assert.strictEqual(
        parentExit.spanId,
        parentEnter.spanId,
        'Parent exit should retain its original span id'
    );

    console.log('unawaited sibling parenting OK');
}

async function main() {
    await testUnawaitedOrdering();
    await testUnawaitedSiblingParenting();
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
