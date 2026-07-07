const DEFAULT_ALLOWED_METHODS = 'GET, OPTIONS';
const DEFAULT_ALLOWED_HEADERS = 'Content-Type';
const DEFAULT_MAX_AGE_SECONDS = '600';
function appendVary(headers, value) {
    const existing = headers.get('Vary');
    if (!existing) {
        headers.set('Vary', value);
        return;
    }
    const values = existing.split(',').map((item) => item.trim().toLowerCase());
    if (!values.includes(value.toLowerCase())) {
        headers.set('Vary', `${existing}, ${value}`);
    }
}
function normalizeAllowedOrigins(allowedOrigins) {
    if (allowedOrigins instanceof Set)
        return allowedOrigins;
    return new Set(allowedOrigins);
}
export function createAskCors(options) {
    const allowed = normalizeAllowedOrigins(options.allowedOrigins);
    const allowedMethods = options.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
    const allowedHeaders = options.allowedHeaders ?? DEFAULT_ALLOWED_HEADERS;
    const maxAgeSeconds = options.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    function isAllowedOrigin(origin) {
        return origin !== undefined && allowed.has(origin);
    }
    function apply(request, response) {
        const origin = request.headers.get('Origin') ?? undefined;
        const headers = new Headers(response.headers);
        appendVary(headers, 'Origin');
        if (!isAllowedOrigin(origin)) {
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers,
            });
        }
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Methods', allowedMethods);
        headers.set('Access-Control-Allow-Headers', allowedHeaders);
        headers.set('Access-Control-Max-Age', maxAgeSeconds);
        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }
    function preflight(request) {
        return apply(request, new Response(null, { status: 204 }));
    }
    return { apply, preflight, isAllowedOrigin };
}
