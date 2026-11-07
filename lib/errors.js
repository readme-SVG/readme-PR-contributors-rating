/**
 * Error taxonomy for the badge service.
 *
 * Two disjoint families exist:
 *   * {@link BadgeRequestError}  – the caller sent something we cannot honour
 *     (invalid date filter, unusable username). Mapped to HTTP 400 in JSON
 *     mode and to an inline SVG notice in badge mode.
 *   * {@link BadgeUpstreamError} – GitHub could not answer (rate limit,
 *     expired token, timeout). Mapped to HTTP 429/502 in JSON mode.
 *
 * Both carry a message that is safe to show to end users, so the handler never
 * has to translate internal details into user-facing copy.
 */

/** Base class sharing the `isOperational` marker used by the handler. */
class BadgeError extends Error {
    constructor(message, { status, code } = {}) {
        super(message);
        this.name = new.target.name;
        this.status = status;
        this.code = code;
        this.isOperational = true;
        Error.captureStackTrace?.(this, new.target);
    }
}

/** Invalid client input; `status` is the HTTP status used by the JSON API. */
export class BadgeRequestError extends BadgeError {
    constructor(message, code = 'invalid_request') {
        super(message, { status: 400, code });
    }
}

/** Upstream GitHub failure. */
export class BadgeUpstreamError extends BadgeError {
    constructor(message, code = 'upstream_error', status = 502) {
        super(message, { status, code });
    }
}

/** Narrow an unknown thrown value to an operational badge error. */
export function asOperationalError(error) {
    return error instanceof BadgeError ? error : null;
}
