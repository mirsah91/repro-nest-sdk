# Repro Nest SDK

Capture NestJS request/response data, function traces, and Mongoose activity for
Repro sessions. This SDK is designed for Nest apps running on Express, with
optional tracing and masking controls.

## 1) Install

Requirements:
- Node.js 18+
- NestJS app using Express (default) and optionally Mongoose 6+

Install the package:

```bash
npm install repro-nest
# or
yarn add repro-nest
# or
pnpm add repro-nest
```

## 2) Configure

At minimum, provide your Repro credentials and wire the middleware. If you want
function tracing, call `initReproTracing` before importing your `AppModule` so
Nest classes are instrumented at load time.

```ts
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import mongoose from 'mongoose';
import {
  initReproTracing,
  reproMiddleware,
  reproMongoosePlugin,
} from 'repro-nest';

const reproConfig = {
  appId: process.env.REPRO_APP_ID as string,
  appName: process.env.REPRO_APP_NAME as string,
  tenantId: process.env.REPRO_TENANT_ID as string,
  appSecret: process.env.REPRO_APP_SECRET as string,
};

async function bootstrap() {
  // Enable function tracing before loading your modules.
  initReproTracing({
    disableFunctionTypes: ['constructor'],
    logFunctionCalls: false,
  });

  // Optional: capture MongoDB queries + document diffs.
  mongoose.plugin(reproMongoosePlugin(reproConfig));

  const { AppModule } = await import('./app.module');
  const app = await NestFactory.create(AppModule);

  // Capture request/response payloads for tagged Repro sessions.
  app.use(reproMiddleware(reproConfig));

  await app.listen(3000);
}

bootstrap();
```

Configuration notes:
- `REPRO_API_BASE` (optional) overrides the backend base URL used to send data.
- `REPRO_APP_NAME` (optional) sets `appName`, which is sent as `X-App-Name`.

### initReproTracing

Enables function tracing. Call this before importing `AppModule` so Nest classes
are loaded through the tracer.

Options (type -> purpose):
- `instrument` (boolean): enable or disable instrumentation of loaded modules.
- `include` (RegExp[]): file path include patterns for instrumentation.
- `exclude` (RegExp[]): file path exclude patterns for instrumentation.
- `mode` (string): tracer mode (defaults to `TRACE_MODE` or `trace`).
- `samplingMs` (number): sampling interval in milliseconds.
- `disableFunctionTraces` (DisableFunctionTraceConfig[] | null): drop trace events
  that match rule objects or predicates.
- `disableFunctionTypes` (TraceRulePattern | null): drop events for matching
  function kinds (for example, constructors).
- `disableTraceFiles` (DisableTraceFileConfig | DisableTraceFileConfig[] | null):
  drop events emitted from matching files.
- `traceInterceptors` (boolean): include Nest interceptors in traces (default false).
- `logFunctionCalls` (boolean): log enter/exit events to console.

Type reference:
- `TraceRulePattern`: `string | number | RegExp | Array<string | number | RegExp>`
- `DisableFunctionTraceConfig`: `DisableFunctionTraceRule | DisableFunctionTracePredicate`
- `DisableFunctionTracePredicate`: `(event: TraceEventForFilter) => boolean`
- `DisableFunctionTraceRule` fields (all accept `TraceRulePattern`):
  - `fn` / `functionName`: function name substring/regex
  - `wrapper` / `wrapperClass` / `className` / `owner`: wrapper/owner name
  - `file`: source filename
  - `line`: source line number
  - `lib` / `library`: npm package name inferred from path
  - `type` / `functionType`: function kind (`method`, `constructor`, etc.)
  - `event` / `eventType`: trace phase (`enter` or `exit`)
- `DisableTraceByFilename`: `{ file: TraceRulePattern }`
- `DisableTraceFileConfig`: `TraceRulePattern | DisableTraceByFilename | null | undefined`

Full config example (shows every option; aliases are interchangeable, use one per group in real configs):

```ts
import { initReproTracing } from 'repro-nest';

initReproTracing({
  instrument: true,
  include: [/^\/app\/src\//],
  exclude: [/node_modules\//, /dist\//],
  mode: process.env.TRACE_MODE || 'trace',
  samplingMs: 10,
  disableFunctionTraces: [
    {
      fn: 'findAll',
      wrapper: 'TasksService',
      file: 'src/tasks/tasks.service.ts',
      line: 27,
      lib: 'mongoose',
      type: 'method',
      event: 'exit',
    },
    {
      functionName: 'formatSensitiveData',
      wrapperClass: 'AuthService',
      className: 'AuthService',
      owner: 'AuthService',
      library: 'bcrypt',
      functionType: 'method',
      eventType: 'enter',
    },
    (event) => event.fn?.startsWith('debug') ?? false,
  ],
  disableFunctionTypes: ['constructor', /getter/i],
  disableTraceFiles: [
    /node_modules\/some-logger\//,
    { file: 'dist/health.check.js' },
    'dist/generated.js',
  ],
  traceInterceptors: true,
  logFunctionCalls: false,
});
```

### reproMiddleware

Captures request/response payloads for active Repro sessions. Requests must
include `x-bug-session-id` and `x-bug-action-id` headers to be captured.

Options (type -> purpose):
- `appId` (string): Repro app id.
- `appName` (string, optional): Repro app name (sent as `X-App-Name`).
- `tenantId` (string): Repro tenant id.
- `appSecret` (string): Repro app secret.
- `captureHeaders` (boolean | HeaderCaptureOptions): enable/disable header capture
  and masking.
- `masking` (ReproMaskingConfig): mask request/response bodies and trace args/returns.

Header capture options (`HeaderCaptureOptions`):
- `allowSensitiveHeaders` (boolean): keep default sensitive headers unmasked.
- `maskHeaders` (HeaderRule | HeaderRule[]): header names to mask.
- `dropHeaders` (HeaderRule | HeaderRule[]): alias for `maskHeaders`.
- `unmaskHeaders` (HeaderRule | HeaderRule[]): header names to keep unmasked.
- `keepHeaders` (HeaderRule | HeaderRule[]): alias for `unmaskHeaders`.
- `HeaderRule`: `string | RegExp`

Masking options (`ReproMaskingConfig`):
- `replacement` (any): default replacement value (defaults to `"[REDACTED]"`).
- `rules` (ReproMaskRule[] | null): list of masking rules.

Masking rule options (`ReproMaskRule`):
- `when` (ReproMaskWhen): scope rules by request or function trace fields.
- `target` (ReproMaskTarget | ReproMaskTarget[]): where to apply the mask.
- `paths` (string | string[]): dot/bracket paths to mask.
- `keys` (TraceRulePattern): mask keys anywhere in the payload.
- `replacement` (any): override replacement value for this rule.

`ReproMaskTarget` values:
- `request.headers`, `request.body`, `request.params`, `request.query`
- `response.body`, `trace.args`, `trace.returnValue`, `trace.error`

`ReproMaskWhen` fields (all accept `TraceRulePattern` unless noted):
- Request scope: `method`, `path`, `key`
- Function scope: `fn` / `functionName`, `wrapper` / `wrapperClass` / `className` / `owner`,
  `file`, `line`, `lib` / `library`, `type` / `functionType`, `event` / `eventType`

Full config example (shows every option; aliases are interchangeable, use one per group in real configs):

```ts
import { reproMiddleware } from 'repro-nest';

app.use(reproMiddleware({
  appId: process.env.REPRO_APP_ID as string,
  appName: process.env.REPRO_APP_NAME as string,
  tenantId: process.env.REPRO_TENANT_ID as string,
  appSecret: process.env.REPRO_APP_SECRET as string,
  captureHeaders: {
    allowSensitiveHeaders: false,
    maskHeaders: [/authorization/i, /cookie/i],
    dropHeaders: ['x-api-key'],
    unmaskHeaders: ['x-request-id'],
    keepHeaders: ['x-trace-id'],
  },
  masking: {
    replacement: '[REDACTED]',
    rules: [
      {
        when: { method: 'POST', path: '/api/auth/login', key: 'POST /api/auth/login' },
        target: ['request.body', 'response.body'],
        paths: ['password'],
        keys: [/token/i],
        replacement: '[FILTERED]',
      },
      {
        when: {
          functionName: 'findAll',
          wrapperClass: 'TasksService',
          file: 'src/tasks/tasks.service.ts',
          line: 27,
          library: 'mongoose',
          functionType: 'method',
          eventType: 'exit',
        },
        target: ['trace.args', 'trace.returnValue', 'trace.error'],
        paths: ['0.user.token'],
        keys: ['password'],
      },
      {
        when: {
          fn: 'create',
          wrapper: 'UsersService',
          className: 'UsersService',
          owner: 'UsersService',
          lib: 'mongoose',
          type: 'method',
          event: 'enter',
        },
        target: 'trace.args',
        paths: ['0.password'],
      },
    ],
  },
}));
```

See `docs/tracing.md` for full masking and trace filtering details.

### Mongoose plugin

`reproMongoosePlugin` attaches schema middleware to capture query activity and
document diffs. It emits data only when a Repro session is active (i.e., when
`reproMiddleware` has set the session context for the current request).

Arguments:
- `appId` (string): Repro app id
- `appName` (string, optional): Repro app name (sent as `X-App-Name`)
- `tenantId` (string): Repro tenant id
- `appSecret` (string): Repro app secret

Example: global plugin (all schemas)

```ts
import mongoose from 'mongoose';
import { reproMongoosePlugin } from 'repro-nest';

mongoose.plugin(reproMongoosePlugin({
  appId: process.env.REPRO_APP_ID as string,
  appName: process.env.REPRO_APP_NAME as string,
  tenantId: process.env.REPRO_TENANT_ID as string,
  appSecret: process.env.REPRO_APP_SECRET as string,
}));
```

Example: Nest `MongooseModule` connection factory

```ts
import { MongooseModule } from '@nestjs/mongoose';
import { reproMongoosePlugin } from 'repro-nest';

MongooseModule.forRoot(process.env.MONGO_URL as string, {
  connectionFactory: (connection) => {
    connection.plugin(reproMongoosePlugin({
      appId: process.env.REPRO_APP_ID as string,
      appName: process.env.REPRO_APP_NAME as string,
      tenantId: process.env.REPRO_TENANT_ID as string,
      appSecret: process.env.REPRO_APP_SECRET as string,
    }));
    return connection;
  },
});
```

Example: schema-level plugin (single model)

```ts
import { Schema } from 'mongoose';
import { reproMongoosePlugin } from 'repro-nest';

const userSchema = new Schema({ email: String });
userSchema.plugin(reproMongoosePlugin({
  appId: process.env.REPRO_APP_ID as string,
  appName: process.env.REPRO_APP_NAME as string,
  tenantId: process.env.REPRO_TENANT_ID as string,
  appSecret: process.env.REPRO_APP_SECRET as string,
}));
```

## 3) Run

Run your Nest app as usual after wiring the SDK:

```bash
npm run start:dev
# or
node dist/main.js
```

If you use `initReproTracing`, keep it at the top of your bootstrap so modules
load after instrumentation is enabled.

## 4) Verify It Works

Send a request with Repro headers and confirm the session shows up in Repro.

```bash
curl \
  -H "x-bug-session-id: session-123" \
  -H "x-bug-action-id: action-123" \
  http://localhost:3000/health
```

Verification tips:
- If the Repro UI does not show the session, confirm `REPRO_API_BASE` and
  credentials are correct.
- Temporarily set `logFunctionCalls: true` in `initReproTracing` to see trace
  enter/exit logs in your console.
- If you use Mongoose, exercise a query/mutation and verify DB entries appear
  in the session trace.
