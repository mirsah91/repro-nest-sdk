// repro-node/src/integrations/sendgrid.ts
import { AsyncLocalStorage } from 'async_hooks';

type Ctx = { sid?: string; aid?: string };
const als = new AsyncLocalStorage<Ctx>();
export const getCtx = () => als.getStore() || {};

// If you already export als/getCtx from repro-node, reuse that instead of re-declaring.

async function post(
    cfg: { tenantId: string; appId: string; appSecret: string; apiBase?: string },
    sessionId: string,
    body: any,
) {
    try {
        const envBase = typeof process !== 'undefined' ? (process as any)?.env?.REPRO_API_BASE : undefined;
        const legacyBase = (cfg as any)?.apiBase;
        const apiBase = String(envBase || legacyBase || 'https://api.repro.ai').replace(/\/+$/, '');
        await fetch(`${apiBase}/v1/sessions/${sessionId}/backend`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-App-Id': cfg.appId,
                'X-App-Secret': cfg.appSecret,
                'X-Tenant-Id': cfg.tenantId,
            },
            body: JSON.stringify(body),
        });
    } catch { /* swallow */ }
}

export type SendgridPatchConfig = {
    appId: string;
    tenantId: string;
    appSecret: string;
    // Optional: provide a function to resolve sid/aid if AsyncLocalStorage is not set
    resolveContext?: () => { sid?: string; aid?: string } | undefined;
};

/**
 * Patch @sendgrid/mail's send() and sendMultiple() to capture outbound email.
 * Idempotent. No behavior change for the app.
 */
export function patchSendgridMail(cfg: SendgridPatchConfig) {
    let sgMail: any;
    try { sgMail = require('@sendgrid/mail'); } catch { return; } // not installed → no-op

    if (!sgMail || (sgMail as any).__repro_patched) return;
    (sgMail as any).__repro_patched = true;

    const origSend = sgMail.send?.bind(sgMail);
    const origSendMultiple = sgMail.sendMultiple?.bind(sgMail);

    if (origSend) {
        sgMail.send = async function patchedSend(msg: any, isMultiple?: boolean) {
            const startedAt = Date.now();
            let statusCode: number | undefined;
            let headers: Record<string, any> | undefined;

            try {
                const res = await origSend(msg, isMultiple);
                // sendgrid returns [response] as array in v7.x
                const r = Array.isArray(res) ? res[0] : res;
                statusCode = r?.statusCode ?? r?.status ?? undefined;
                headers = r?.headers ?? undefined;
                return res;
            } finally {
                fireCapture('send', msg, startedAt, statusCode, headers);
            }
        };
    }

    if (origSendMultiple) {
        sgMail.sendMultiple = async function patchedSendMultiple(msg: any) {
            const startedAt = Date.now();
            let statusCode: number | undefined;
            let headers: Record<string, any> | undefined;

            try {
                const res = await origSendMultiple(msg);
                const r = Array.isArray(res) ? res[0] : res;
                statusCode = r?.statusCode ?? r?.status ?? undefined;
                headers = r?.headers ?? undefined;
                return res;
            } finally {
                fireCapture('sendMultiple', msg, startedAt, statusCode, headers);
            }
        };
    }

    function fireCapture(kind: 'send' | 'sendMultiple', rawMsg: any, t0: number, statusCode?: number, headers?: any) {
        const ctx = getCtx();
        const sid = ctx.sid ?? cfg.resolveContext?.()?.sid;
        const aid = ctx.aid ?? cfg.resolveContext?.()?.aid;
        if (!sid) return; // no active session → skip

        const norm = normalizeSendgridMessage(rawMsg);
        const entry = {
            actionId: aid ?? null,
            email: {
                provider: 'sendgrid',
                kind,
                to: norm.to,
                cc: norm.cc,
                bcc: norm.bcc,
                from: norm.from,
                subject: norm.subject,
                text: norm.text,                 // you said privacy later → include now
                html: norm.html,                 // idem
                templateId: norm.templateId,
                dynamicTemplateData: norm.dynamicTemplateData,
                categories: norm.categories,
                customArgs: norm.customArgs,
                attachmentsMeta: norm.attachmentsMeta, // safe metadata only
                statusCode,
                durMs: Date.now() - t0,
                headers: headers ?? {},
            },
            t: Date.now(),
        };

        post(cfg, sid, { entries: [entry] });
    }

    function normalizeAddress(a: any): { email: string; name?: string } | null {
        if (!a) return null;
        if (typeof a === 'string') return { email: a };
        if (typeof a === 'object' && a.email) return { email: String(a.email), name: a.name ? String(a.name) : undefined };
        return null;
    }

    function normalizeAddressList(v: any): Array<{ email: string; name?: string }> | undefined {
        if (!v) return undefined;
        const arr = Array.isArray(v) ? v : [v];
        const out = arr.map(normalizeAddress).filter(Boolean) as Array<{ email: string; name?: string }>;
        return out.length ? out : undefined;
    }

    function normalizeSendgridMessage(msg: any) {
        // sendgrid supports "personalizations" & top-level fields; we’ll flatten the common pieces
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
                    size: a?.content ? byteLen(a.content) : undefined, // base64 or string → approximate size
                }))
                : undefined,
        };

        // If personalizations exist, pull the FIRST one as representative (keeps MVP simple)
        const p0 = Array.isArray(msg?.personalizations) ? msg.personalizations[0] : undefined;
        if (p0) {
            base.to = normalizeAddressList(p0.to) ?? base.to;
            base.cc = normalizeAddressList(p0.cc) ?? base.cc;
            base.bcc = normalizeAddressList(p0.bcc) ?? base.bcc;
            if (!base.subject && p0.subject) base.subject = String(p0.subject);
            // template data can also live inside personalization
            if (!base.dynamicTemplateData && p0.dynamic_template_data) base.dynamicTemplateData = p0.dynamic_template_data;
            if (!base.customArgs && p0.custom_args) base.customArgs = p0.custom_args;
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
