# Repro Tracing Configuration

Use `initReproTracing` to start the tracer and control which instrumented calls
are persisted. The helper exposes two optional knobs:

```ts
initReproTracing({
  disableFunctionTraces: [
    // Drop all constructor calls coming from mongoose models
    { library: 'mongoose', functionType: 'constructor' },

    // Ignore a specific helper by name
    { fn: 'formatSensitiveData' },

    // Skip noisy enter logs from a third-party file using a regular expression
    { file: /node_modules\/some-logger\/.*\.js$/ },

    // Provide a custom predicate for advanced logic
    (event) => event.fn?.startsWith('debug') ?? false,
  ],
  disableFunctionTypes: ['constructor'],
  logFunctionCalls: false,
});
```

## `disableFunctionTypes`

Shorthand for suppressing entire categories of functions such as constructors
or getters. Provide a string, regular expression, or array of them and every
matching trace event will be ignored, regardless of library or filename.

```ts
import { setDisabledFunctionTypes } from 'repro-nest';

setDisabledFunctionTypes(['constructor']);
```

Pass `null` or an empty array to reset the filter. This is useful when you want
to silence noisy dependency-injection constructors globally while still
allowing more targeted rules to run.

## `disableFunctionTraces`

Accepts an array of declarative rules or predicate functions. If any rule or
predicate returns `true` for an event, the tracer drops that event before it is
captured in the session payload.

### Declarative rule fields

| Property        | Description                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `fn`/`functionName` | Match against the instrumented function name (substring or RegExp).                                |
| `wrapper`/`wrapperClass`/`className`/`owner` | Match the wrapper/owner inferred from the function name (e.g. `"UserService"` in `"UserService.create"`). |
| `file`          | Match the filename reported by the trace event (callsite when available; may fall back to the function definition file when the caller is not instrumented). |
| `line`          | Match the line number reported by the trace event.                                                  |
| `lib`/`library` | Match the npm package inferred from the file path (e.g. `"mongoose"`).                              |
| `type`/`functionType` | Match the detected function kind (e.g. `"constructor"`, `"method"`, `"arrow"`).                |
| `event`/`eventType` | Match the trace phase (`"enter"` or `"exit"`) to suppress only specific edges of a call.          |

Each field accepts a string, regular expression, or array of them. Empty values
are ignored, so you can combine fields to scope rules as narrowly as needed.

### Predicate rules

Provide a function that receives the raw trace event and returns `true` when it
should be discarded. Use this form for complex, stateful, or cross-field logic.

```ts
import { setDisabledFunctionTraces } from 'repro-nest';

setDisabledFunctionTraces([
  (event) => event.library === 'mongoose' && event.functionType === 'constructor',
]);
```

Pass `null` or an empty array to `initReproTracing` or `setDisabledFunctionTraces`
to remove previously configured rules.

## Payload masking (`reproMiddleware`)

`reproMiddleware` can mask request/response payloads, request headers, and traced
function inputs/outputs before they are persisted.

### Targets

- `request.headers`
- `request.body`
- `request.params`
- `request.query`
- `response.body`
- `trace.args`
- `trace.returnValue`
- `trace.error`

### Rules

- `when.method` / `when.path` / `when.key` scope rules by endpoint (`key` is `"METHOD /path"` without query string).
- For function-specific rules, `when` supports the same fields as `disableFunctionTraces` (`fn`, `wrapperClass`, `file`, `line`, etc). This is useful when multiple functions share the same name.
- `paths` uses dot/bracket syntax and supports `*`, `[0]`, `[*]` (example: `"items[*].token"` or `"0.password"` for trace args arrays).
- `keys` masks matching key names anywhere in the payload (string/RegExp/array).
- `replacement` overrides the default replacement value (defaults to `"[REDACTED]"`).

```ts
import { reproMiddleware } from 'repro-nest';

app.use(reproMiddleware({
  appId,
  tenantId,
  appSecret,
  apiBase,
  masking: {
    rules: [
      {
        when: { key: 'POST /api/auth/login' },
        target: 'request.body',
        paths: ['password'],
      },
      {
        when: { wrapperClass: 'AuthService', functionName: 'login', file: '/app/src/auth/auth.service.ts' },
        target: ['trace.args', 'trace.returnValue', 'trace.error'],
        keys: [/token/i],
      },
      {
        target: 'request.headers',
        keys: [/authorization/i, /cookie/i],
      },
    ],
  },
}));
```

### Header capture/masking (`captureHeaders`)

Headers are captured by default with sensitive values masked. Configure `captureHeaders`
to change the behavior:

- `captureHeaders: false` disables header capture entirely.
- `captureHeaders: true` (or omitted) captures headers and masks sensitive ones.
- `captureHeaders.allowSensitiveHeaders: true` keeps default sensitive headers unmasked (use with care).
- `captureHeaders.maskHeaders` adds additional header names to mask.
- `captureHeaders.unmaskHeaders` keeps specific header names unmasked (overrides defaults and `maskHeaders`).
- `captureHeaders.dropHeaders` / `captureHeaders.keepHeaders` are legacy aliases for `maskHeaders` / `unmaskHeaders`.

## `logFunctionCalls`

Set to `true` to enable verbose console logging of function entry/exit events at
runtime, or to `false` to silence them. The value is forwarded to
`setReproTraceLogsEnabled`, so you can also toggle logging later in the process:

```ts
import { enableReproTraceLogs, disableReproTraceLogs } from 'repro-nest';

enableReproTraceLogs();
// ...
disableReproTraceLogs();
```

These helpers are safe to call even if the tracer failed to initialize; they
simply no-op when tracing is unavailable.
