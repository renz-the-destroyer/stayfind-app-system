// Simple in-memory cache for GET /api/view (userController.js's getAllListings).
//
// Freshness is handled by clearing the WHOLE cache whenever anything that could
// change what getAllListings returns happens: a listing is added, edited, hidden,
// unhidden or deleted, a review is posted, or a user is approved/suspended.
//
// This is intentionally a plain in-memory Map, not Redis or similar - it resets
// on every server restart, which is fine since it is only a short-lived speed-up.

const TTL_MS = 30 * 1000; // 30 seconds
const store = new Map();

// Keyed by the handful of query params getAllListings actually reads.
// `owner` (Module 7) is '1' when a landlord is viewing their OWN listings (which
// include hidden ones), so that view can never be served to anybody else.
function buildKey(query) {
    return JSON.stringify({
        role: query.role || '',
        user_id: query.user_id || '',
        page: query.page || '',
        limit: query.limit || '',
        all: query.all || '',
        owner: query.owner || ''
    });
}

function get(query) {
    const key = buildKey(query);
    const entry = store.get(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > TTL_MS) {
        store.delete(key);
        return null;
    }
    return entry.data;
}

function set(query, data) {
    store.set(buildKey(query), { data, cachedAt: Date.now() });
}

function clear() {
    store.clear();
}

module.exports = { get, set, clear };
