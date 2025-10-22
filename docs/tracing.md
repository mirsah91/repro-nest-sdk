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
  // Silence every trace event emitted from specific source files
  disableTraceFiles: [
    'src/services/debug.service.ts',   // filename suffix match
    'src/utils/',                      // directory match (must include a slash)
    /node_modules\/some-logger\//i,    // or a RegExp against the normalized path
  ],
  logFunctionCalls: false,
});
```

## `disableFunctionTypes`

Shorthand for suppressing entire categories of functions such as constructors
or getters. Provide a string, regular expression, or array of them and every
matching trace event will be ignored, regardless of library or filename.

```ts
import { setDisabledFunctionTypes } from '@repro/sdk';

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
| `file`          | Match the absolute source filename, useful for filtering entire modules.                           |
| `lib`/`library` | Match the npm package inferred from the file path (e.g. `"mongoose"`).                              |
| `type`/`functionType` | Match the detected function kind (e.g. `"constructor"`, `"method"`, `"arrow"`).                |
| `event`/`eventType` | Match the trace phase (`"enter"` or `"exit"`) to suppress only specific edges of a call.          |

Each field accepts a string, regular expression, or array of them. Empty values
are ignored, so you can combine fields to scope rules as narrowly as needed.

### Predicate rules

Provide a function that receives the raw trace event and returns `true` when it
should be discarded. Use this form for complex, stateful, or cross-field logic.

```ts
import { setDisabledFunctionTraces } from '@repro/sdk';

setDisabledFunctionTraces([
  (event) => event.library === 'mongoose' && event.functionType === 'constructor',
]);
```

Pass `null` or an empty array to `initReproTracing` or `setDisabledFunctionTraces`
to remove previously configured rules.

## `disableTraceFiles`

Provides a shorthand for muting every trace event whose source file matches the
supplied patterns. Strings are case-insensitive and match either the filename
suffix (when no slash is present) or any path segment (when the string contains
`/`). For very short tokens (one or two characters), provide the full filename
or basename you want to ignore (for example `"db"` to skip `db.ts`). Regular
expressions receive the normalized path with forward slashes, so the same
pattern works on all platforms.

```ts
import { setDisabledTraceFiles } from '@repro/sdk';

// stop recording traces from local development helpers
setDisabledTraceFiles([
  'src/dev-tools/',
  'scripts/seed.ts',
]);

// reset the filter later on
setDisabledTraceFiles(null);
```

## `logFunctionCalls`

Set to `true` to enable verbose console logging of function entry/exit events at
runtime, or to `false` to silence them. The value is forwarded to
`setReproTraceLogsEnabled`, so you can also toggle logging later in the process:

```ts
import { enableReproTraceLogs, disableReproTraceLogs } from '@repro/sdk';

enableReproTraceLogs();
// ...
disableReproTraceLogs();
```

These helpers are safe to call even if the tracer failed to initialize; they
simply no-op when tracing is unavailable.
