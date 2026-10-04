// NEW: Simple in-memory cache for GET /api/view (userController.js's
// getAllListings). Every page load used to re-run the full listings query -
// including the avg_rating/review_count subqueries and the landlord JOIN -
// from scratch against MySQL, even when ten people loaded the same page
// within the same few seconds. This caches that response in memory for a
// short TTL so repeat requests (many people browsing, or Load More
// re-rendering) are served instantly instead of re-querying every time.
//
// Freshness is handled by clearing the WHOLE cache (not just one entry)
// whenever anything that could change what getAllListings returns happens:
// a listing is added, edited, or deleted, or a review is posted (since that
// changes avg_rating/review_count). Clearing everything is simpler and
// safer than trying to selectively invalidate just the affected page/filter
// combination, and at this app's scale the cache rebuilds itself on the
// next request anyway - there's no meaningful cost to clearing it all.
//
// This is intentionally a plain in-memory Map, not Redis or similar - it
// resets on every server restart (Render's free tier restarts periodically
// on its own), which is fine here since the cache is just a short-lived
// speed-up, never the source of truth.

const TTL_MS = 30 * 1000; // 30 seconds
const store = new Map();

// Keyed by the handful of query params getAllListings actually reads, so
// different pages/filters (page 1 vs page 2, a landlord's own listings vs
// the public feed, ?all=true for the Saved view) each get their own entry
// instead of colliding with each other.
function buildKey(query) {
    return JSON.stringify({
        role: query.role || '',
        user_id: query.user_id || '',
        page: query.page || '',
        limit: query.limit || '',
        all: query.all || ''
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
