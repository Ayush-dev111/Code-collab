// A final allowlist is applied to every event, including automatically captured
// events. Error messages and request/SQL/document content are intentionally absent.
export function scrubMonitoringEvent<
  T extends {
    event_id?: string;
    timestamp?: number;
    platform?: string;
    level?: string;
    environment?: string;
    exception?: {
      values?: Array<{
        type?: string;
        value?: string;
        stacktrace?: {
          frames?: Array<{
            filename?: string;
            function?: string;
            lineno?: number;
            colno?: number;
            in_app?: boolean;
          }>;
        };
      }>;
    };
  },
>(event: T): T {
  const cleaned = {
    event_id: event.event_id,
    timestamp: event.timestamp,
    platform: event.platform,
    level: event.level,
    environment:
      event.environment && /^[a-zA-Z0-9_-]{1,40}$/.test(event.environment)
        ? event.environment
        : undefined,
    exception: event.exception
      ? {
          values: event.exception.values?.map((value) => ({
            type: [
              "Error",
              "TypeError",
              "RangeError",
              "SyntaxError",
              "ReferenceError",
              "AggregateError",
            ].includes(value.type ?? "")
              ? value.type
              : "Error",
            value: "Unexpected application error",
            stacktrace: value.stacktrace
              ? {
                  frames: value.stacktrace.frames?.map((frame) => ({
                    filename: frame.filename
                      ?.split(/[\\/]/)
                      .at(-1)
                      ?.split(/[?#]/)[0]
                      ?.slice(0, 160),
                    function: frame.function
                      ?.replace(/[^a-zA-Z0-9_.$<>\[\] -]/g, "")
                      .slice(0, 120),
                    lineno: frame.lineno,
                    colno: frame.colno,
                    in_app: frame.in_app,
                  })),
                }
              : undefined,
          })),
        }
      : undefined,
  };
  return cleaned as T;
}
export const privateMonitoringOptions = {
  dataCollection: {
    userInfo: false,
    cookies: false,
    httpHeaders: false,
    httpBodies: [],
    urlQueryParams: false,
    genAI: { inputs: false, outputs: false },
    databaseQueryData: false,
    queues: false,
    stackFrameVariables: false,
    frameContextLines: 0,
    graphQL: { document: false, variables: false },
  },
  tracesSampleRate: 0,
  maxBreadcrumbs: 0,
  enableLogs: false,
  beforeSend: scrubMonitoringEvent,
};
