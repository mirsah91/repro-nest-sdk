process.env.TRACE_RELOAD_CACHE = '0';
require('../tracer/register');
const assert = require('assert');
const { trace } = require('../tracer/runtime');

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const handlers = [
    {
        getRecipients: async () => { await wait(10); return ['a']; },
        getTemplate: () => 'tmpl1',
    },
    {
        getRecipients: async () => { await wait(1); return ['b']; },
        getTemplate: () => 'tmpl2',
    },
];

async function handlerWorker(handler) {
    const recipients = await handler.getRecipients();
    const template = await handler.getTemplate();
    return { recipients, template };
}

async function runScenario() {
    const results = handlers.map(handler => handlerWorker(handler));
    return Promise.all(results);
}

async function main() {
    const events = [];
    const off = trace.on(ev => { if (ev && ev.traceId === 'map-loop') events.push(ev); });

    await trace.withTrace('map-loop', async () => {
        await runScenario();
    });

    // Give any pending promise callbacks a moment to emit their exits.
    await wait(10);
    off();

    const enters = (name) => events.filter(ev => ev && ev.type === 'enter' && ev.fn === name);

    const workerEnters = enters('handlerWorker');
    const recipientsEnters = enters('handler.getRecipients');
    const templateEnters = enters('handler.getTemplate');

    const uniq = (arr) => Array.from(new Set(arr));

    const workerSpanIds = uniq(workerEnters.map(ev => ev.spanId).filter(Boolean));
    const recipientSpanIds = new Set(recipientsEnters.map(ev => ev.spanId).filter(Boolean));
    const templateParentIds = uniq(templateEnters.map(ev => ev.parentSpanId).filter(Boolean));

    assert(workerSpanIds.length >= 2, 'expected at least two handlerWorker spans');
    assert(recipientsEnters.length >= 2, 'expected two getRecipients entries');
    assert(templateEnters.length >= 2, 'expected two getTemplate entries');
    assert.strictEqual(templateParentIds.length, 2, 'expected templates to attach to two distinct handler spans');

    templateEnters.forEach(ev => {
        assert(workerSpanIds.includes(ev.parentSpanId),
            'getTemplate should be parented to its map callback (handlerWorker)');
        assert(!recipientSpanIds.has(ev.parentSpanId),
            'getTemplate should not be nested under getRecipients span');
    });

    console.log('promise map + Promise.all trace parenting OK');
}

main().catch(err => {
    console.error(err);
    process.exitCode = 1;
});
