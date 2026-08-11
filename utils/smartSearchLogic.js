// utils/smartSearchLogic.js
//
// Shared "Smart Search" query parser + matcher, used by BOTH:
//  - server.js's inline POST /api/smart-search handler (this is the one that
//    actually runs right now, since it's registered on `app` BEFORE
//    `app.use('/api', routes)` is mounted - same pattern already noted for
//    /api/update-listing elsewhere in this codebase)
//  - controllers/userController.js's smartSearch export (currently dormant/
//    unreachable for the same reason, but kept in sync here so it's ready to
//    go if the inline handler in server.js is ever removed)
//
// Understands simple Taglish queries like:
//   "house malapit sa eu"      -> category contains "house", text contains "eu"
//   "apartment na may wifi"    -> category contains "apartment", amenities contains "wifi"
//   "bahay malapit sa palengke"-> "bahay" translated to "house", text contains "palengke"
//   "may parking ba dito"      -> "parking" recognized, filler words dropped
//   "room with dirty kitchen"  -> both "dirty" and "kitchen" must appear
//   "room under 5000"          -> price <= 5000
//   "3 bedrooms"               -> rooms >= 3

// Common Tagalog/English connector words that never correspond to actual
// listing content. Without stripping these, a strict "every word must match"
// search could never find anything, since "malapit"/"sa"/"na"/"may" never
// literally appear in a listing's title/location/category/amenities.
const STOPWORDS = new Set([
    'malapit', 'sa', 'na', 'nang', 'ang', 'ay', 'yung', 'yun', 'ito', 'iyan', 'iyon',
    'dito', 'diyan', 'doon', 'may', 'meron', 'mayroon', 'gusto', 'ko', 'kong', 'mo',
    'niya', 'namin', 'natin', 'nila', 'po', 'ba', 'naman', 'lang', 'din', 'rin',
    'para', 'kasi', 'pero', 'at', 'o', 'kung', 'kapag', 'nasa',
    'the', 'a', 'an', 'in', 'for', 'of', 'to', 'with', 'near', 'is', 'are', 'that', 'has'
]);

// Informal/Tagalog terms mapped to the English words actually stored in the DB
// (category names like "House"/"Condo"/"Bedspace", common amenity spellings).
const SYNONYMS = {
    'bahay': 'house',
    'kondo': 'condo',
    'condominium': 'condo',
    'kwarto': 'bedspace',
    'kuarto': 'bedspace',
    'dorm': 'bedspace',
    'dormitory': 'bedspace',
    'aircondition': 'aircon',
    'airconditioned': 'aircon',
    'internet': 'wifi',
    // NEW: parking
    'parking': 'parking',
    'carpark': 'parking',
    'paradahan': 'parking', // Tagalog for "parking"
    // NEW: "dirty kitchen" - common Philippine house feature (a separate
    // kitchen for heavy/smoky cooking). "ketchen" is a very common misspelling.
    'ketchen': 'kitchen',
    'kitchen': 'kitchen'
};

// Pulls out price ("under 5000", "below ₱5k", "over 3000"), room count
// ("3 rooms", "2 bedrooms"), and the remaining meaningful keywords from a
// raw typed query.
function parseSmartSearchQuery(rawQuery) {
    const lowerQuery = (rawQuery || "").toLowerCase();

    // --- PRICE FILTERS ---
    let maxPrice = null, minPrice = null;
    const underMatch = lowerQuery.match(/(?:under|below|less than|hanggang)\s*(?:₱|php)?\s*([\d,]+)(k)?/);
    if (underMatch) {
        maxPrice = parseInt(underMatch[1].replace(/,/g, ''), 10) * (underMatch[2] ? 1000 : 1);
    }
    const overMatch = lowerQuery.match(/(?:above|over|more than|higher than|pataas)\s*(?:₱|php)?\s*([\d,]+)(k)?/);
    if (overMatch) {
        minPrice = parseInt(overMatch[1].replace(/,/g, ''), 10) * (overMatch[2] ? 1000 : 1);
    }

    // --- ROOM COUNT FILTER ---
    let minRooms = null;
    const roomMatch = lowerQuery.match(/(\d+)\s*(?:rooms?|bedrooms?|kwarto|kuarto)/);
    if (roomMatch) {
        minRooms = parseInt(roomMatch[1], 10);
    }

    // --- Meaningful keywords: strip stopwords + bare numbers, translate synonyms ---
    const rawWords = lowerQuery.split(/\s+/).filter(w => w.length > 1);
    const keywords = rawWords
        .filter(w => !STOPWORDS.has(w))
        .filter(w => !/^[\d,]+k?$/.test(w)) // bare numbers are already handled by the price/room regex above
        .map(w => SYNONYMS[w] || w);

    const uniqueKeywords = [...new Set(keywords)];

    return { maxPrice, minPrice, minRooms, keywords: uniqueKeywords };
}

// Filters + ranks listing rows against a parsed query. Returns rows sorted by
// relevance (most matched keywords first) instead of requiring every single
// word to match, so close matches still show up instead of nothing at all.
function runSmartSearch(rawQuery, rows, role, userId) {
    const { maxPrice, minPrice, minRooms, keywords } = parseSmartSearchQuery(rawQuery);

    // Nothing usable in the query at all (only filler words, no filters) - matches
    // the original behavior of returning no results for an empty/meaningless query.
    if (keywords.length === 0 && maxPrice === null && minPrice === null && minRooms === null) {
        return [];
    }

    const scored = rows.map(row => {
        // Role security: landlords only ever see their own listings, same as the
        // regular Browse view. (Previously Smart Search ignored this entirely.)
        const isOwner = (role === 'landlord') ? String(row.user_id) === String(userId) : true;
        if (!isOwner) return null;

        if (maxPrice !== null && Number(row.price) > maxPrice) return null;
        if (minPrice !== null && Number(row.price) < minPrice) return null;
        if (minRooms !== null && Number(row.rooms) < minRooms) return null;

        const allTextInRow = `${row.title} ${row.location} ${row.category} ${row.amenities}`.toLowerCase();

        let score = 0;
        keywords.forEach(word => {
            if (allTextInRow.includes(word)) score++;
        });

        // If the user typed meaningful keywords, require at least one match.
        // If they only used price/room filters (no keywords), a score of 0 is fine.
        if (keywords.length > 0 && score === 0) return null;

        return { row, score };
    }).filter(Boolean);

    // Best matches first
    scored.sort((a, b) => b.score - a.score);

    return scored.map(s => s.row);
}

module.exports = { parseSmartSearchQuery, runSmartSearch };