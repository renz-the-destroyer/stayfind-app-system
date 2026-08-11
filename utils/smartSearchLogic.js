// utils/smartSearchLogic.js
//
// Shared "Smart Search" query parser + matcher, used by BOTH:
//  - server.js's inline POST /api/smart-search handler (this is the one that
//    actually runs right now, since it's registered on `app` BEFORE
//    `app.use('/api', routes)` is mounted)
//  - controllers/userController.js's smartSearch export (currently dormant/
//    unreachable for the same reason, but kept in sync here so it's ready to
//    go if the inline handler in server.js is ever removed)
//
// Exported functions are UNCHANGED from before (parseSmartSearchQuery,
// runSmartSearch), so server.js and controllers/userController.js do NOT
// need any changes to use this upgraded version.
//
// ============================================================================
// WHAT THIS UNDERSTANDS NOW
// ============================================================================
//   "house malapit sa eu"        -> category MUST be House, ranks by "eu"
//   "apartment na may wifi"      -> category MUST be Apartment, has wifi
//   "bahay malapit sa palengke"  -> "bahay" -> house (Tagalog)
//   "cheapest condo"             -> category = Condo, sorted price ascending
//   "biggest house near UP"      -> category = House, sorted by size, ranks "up"
//   "room under 5000"            -> price <= 5000
//   "5k pababa na bedspace"      -> price <= 5000 (reversed Tagalog phrasing)
//   "3 bedrooms with parking"    -> rooms >= 3, has parking
//   "30 sqm condo"               -> size >= 30, category = Condo
//   "aparment na may wefi"       -> typos auto-corrected to apartment/wifi
// ============================================================================

// ---------------------------------------------------------------------------
// 1. STOPWORDS
// Common Tagalog/English connector + conversational filler words that never
// correspond to actual listing content. Without stripping these, a strict
// "every word must match" search could never find anything, since words like
// "malapit"/"sa"/"na"/"may"/"can you show me" never appear in a listing's
// title/location/category/amenities.
// ---------------------------------------------------------------------------
const STOPWORDS = new Set([
    // Tagalog connectors / particles
    'malapit', 'sa', 'na', 'nang', 'ang', 'ay', 'yung', 'yun', 'ito', 'iyan', 'iyon',
    'dito', 'diyan', 'doon', 'may', 'meron', 'mayroon', 'gusto', 'ko', 'kong', 'mo',
    'niya', 'namin', 'natin', 'nila', 'po', 'ba', 'naman', 'lang', 'din', 'rin',
    'para', 'kasi', 'pero', 'at', 'o', 'kung', 'kapag', 'nasa', 'pwede', 'pwedeng',
    'maaari', 'maaaring', 'bang', 'eh', 'pala', 'talaga', 'nyo', 'niyo',
    // English connectors
    'the', 'a', 'an', 'in', 'for', 'of', 'to', 'with', 'near', 'is', 'are', 'that', 'has',
    // Conversational filler ("can you show me a house...", "I need an apartment...")
    'can', 'you', 'show', 'me', 'find', 'looking', 'need', 'want', 'give', 'get',
    'search', 'searching', 'please', 'pls', 'there', 'any', 'some', 'i', 'im', "i'm"
]);

// ---------------------------------------------------------------------------
// 2. PROPERTY TYPE DETECTION (hard filter, not a fuzzy keyword)
// If the query names a property type, we filter listings.category directly
// instead of just hoping the word shows up somewhere in the text. This is
// far more precise than treating "house" as just another keyword.
// ---------------------------------------------------------------------------
const CATEGORY_TERMS = {
    'house': 'house', 'houses': 'house', 'bahay': 'house',
    'apartment': 'apartment', 'apartments': 'apartment', 'apt': 'apartment',
    'condo': 'condo', 'condos': 'condo', 'condominium': 'condo', 'kondo': 'condo',
    'bedspace': 'bedspace', 'bedspaces': 'bedspace', 'dorm': 'bedspace',
    'dormitory': 'bedspace', 'kwarto': 'bedspace', 'kuarto': 'bedspace'
};

// ---------------------------------------------------------------------------
// 3. AMENITY / FEATURE SYNONYMS
// Informal, Tagalog, or misspelled terms mapped to the canonical word that
// actually shows up in a listing's amenities text.
// ---------------------------------------------------------------------------
const SYNONYMS = {
    'wifi': 'wifi', 'internet': 'wifi', 'wai-fi': 'wifi',
    'aircon': 'aircon', 'ac': 'aircon', 'aircondition': 'aircon', 'airconditioned': 'aircon',
    'parking': 'parking', 'carpark': 'parking', 'paradahan': 'parking',
    'kitchen': 'kitchen', 'ketchen': 'kitchen', // "dirty kitchen" - separate cooking area
    'furnished': 'furnished', 'furnish': 'furnished', 'fully-furnished': 'furnished',
    'cctv': 'cctv', 'camera': 'cctv',
    'security': 'security', 'guard': 'security',
    'elevator': 'elevator', 'lift': 'elevator',
    'balcony': 'balcony',
    'laundry': 'laundry',
    'petfriendly': 'pet friendly', 'pet': 'pet friendly', 'alaga': 'pet friendly'
};

// ---------------------------------------------------------------------------
// 4. SORT-INTENT WORDS
// These change HOW results are ordered instead of being literal keywords to
// search for, so they're pulled out of the query separately.
// ---------------------------------------------------------------------------
const CHEAP_TERMS = new Set(['cheap', 'cheapest', 'mura', 'pinakamura', 'murang', 'budget', 'affordable']);
const EXPENSIVE_TERMS = new Set(['expensive', 'mahal', 'pinakamahal', 'premium', 'luxury', 'luxurious']);
const BIG_TERMS = new Set(['big', 'biggest', 'large', 'malaki', 'pinakamalaki', 'spacious', 'maluwag', 'malawak']);

// ---------------------------------------------------------------------------
// 5. TYPO-TOLERANCE (fuzzy matching)
// A lightweight Levenshtein edit-distance check so common misspellings still
// resolve to the right term, even ones not explicitly listed in SYNONYMS.
// Only runs on words 4+ letters long so short, legitimate location keywords
// (like "eu", "up") never get mangled.
// ---------------------------------------------------------------------------
const KNOWN_VOCAB = [
    'house', 'apartment', 'condo', 'bedspace', 'dorm', 'dormitory',
    'wifi', 'aircon', 'parking', 'kitchen', 'furnished', 'cctv',
    'security', 'elevator', 'balcony', 'laundry'
];

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i;
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            dp[i][j] = Math.min(
                dp[i - 1][j] + 1,      // deletion
                dp[i][j - 1] + 1,      // insertion
                dp[i - 1][j - 1] + cost // substitution
            );
        }
    }
    return dp[m][n];
}

function fuzzyCorrect(word) {
    if (word.length < 4) return word; // too short to safely auto-correct

    let bestMatch = null;
    let bestDistance = Infinity;
    for (const vocabWord of KNOWN_VOCAB) {
        const distance = levenshtein(word, vocabWord);
        if (distance < bestDistance) {
            bestDistance = distance;
            bestMatch = vocabWord;
        }
    }

    // Allow 1 typo for short-ish words, 2 for longer ones.
    const allowedDistance = word.length <= 6 ? 1 : 2;
    return (bestMatch && bestDistance <= allowedDistance) ? bestMatch : word;
}

// ---------------------------------------------------------------------------
// 6. QUERY PARSER
// Pulls price / room count / size / property type / sort intent out of the
// raw typed query, and returns whatever meaningful keywords are left over.
// ---------------------------------------------------------------------------
function parseSmartSearchQuery(rawQuery) {
    const lowerQuery = (rawQuery || "").toLowerCase().trim();

    // --- PRICE FILTERS: "under 5000", "below ₱5k", "5k pababa", "over 3000" ---
    let maxPrice = null, minPrice = null;

    const underMatch =
        lowerQuery.match(/(?:under|below|less than|hanggang)\s*(?:₱|php)?\s*([\d,]+)(k)?/) ||
        lowerQuery.match(/([\d,]+)(k)?\s*(?:pababa|or less|and below)/);
    if (underMatch) {
        maxPrice = parseInt(underMatch[1].replace(/,/g, ''), 10) * (underMatch[2] ? 1000 : 1);
    }

    const overMatch =
        lowerQuery.match(/(?:above|over|more than|higher than|pataas)\s*(?:₱|php)?\s*([\d,]+)(k)?/) ||
        lowerQuery.match(/([\d,]+)(k)?\s*(?:pataas|or more|and above)/);
    if (overMatch) {
        minPrice = parseInt(overMatch[1].replace(/,/g, ''), 10) * (overMatch[2] ? 1000 : 1);
    }

    // --- ROOM COUNT FILTER: "3 rooms", "2 bedrooms", "3 kwarto" ---
    let minRooms = null;
    const roomMatch = lowerQuery.match(/(\d+)\s*(?:rooms?|bedrooms?|kwarto|kuarto)/);
    if (roomMatch) {
        minRooms = parseInt(roomMatch[1], 10);
    }

    // --- SIZE FILTER: "30 sqm", "at least 25 sq m", "30 square meters" ---
    let minSize = null;
    const sizeMatch = lowerQuery.match(/(\d+)\s*(?:sqm|sq\.?\s?m\.?|square\s?meters?)/);
    if (sizeMatch) {
        minSize = parseInt(sizeMatch[1], 10);
    }

    // --- TOKENIZE ---
    const rawWords = lowerQuery.split(/\s+/).filter(w => w.length > 1);

    // --- PROPERTY TYPE: pulled out as a hard filter, not a soft keyword ---
    let categoryFilter = null;
    const afterCategory = [];
    for (const word of rawWords) {
        if (!categoryFilter && CATEGORY_TERMS[word]) {
            categoryFilter = CATEGORY_TERMS[word];
            continue; // consumed - don't also treat it as a generic keyword
        }
        afterCategory.push(word);
    }

    // --- SORT INTENT: "cheapest", "biggest", "mahal", etc. ---
    let sortBy = null;
    const afterSort = [];
    for (const word of afterCategory) {
        if (!sortBy && CHEAP_TERMS.has(word)) { sortBy = 'price_asc'; continue; }
        if (!sortBy && EXPENSIVE_TERMS.has(word)) { sortBy = 'price_desc'; continue; }
        if (!sortBy && BIG_TERMS.has(word)) { sortBy = 'size_desc'; continue; }
        afterSort.push(word);
    }

    // --- REMAINING MEANINGFUL KEYWORDS: strip stopwords + bare numbers,
    //     translate synonyms, fuzzy-correct anything unrecognized ---
    const keywords = afterSort
        .filter(w => !STOPWORDS.has(w))
        .filter(w => !/^[\d,]+k?$/.test(w)) // bare numbers already handled above
        .map(w => SYNONYMS[w] || fuzzyCorrect(w));

    const uniqueKeywords = [...new Set(keywords)];

    return { maxPrice, minPrice, minRooms, minSize, categoryFilter, sortBy, keywords: uniqueKeywords };
}

// ---------------------------------------------------------------------------
// 7. MATCHER + RANKER
// Filters rows against the parsed query, scores each surviving row by
// weighted relevance (title matches count more than amenities, which count
// more than location), then sorts - either by the detected sort intent
// (cheapest/biggest/etc.) or by relevance score.
// ---------------------------------------------------------------------------
function runSmartSearch(rawQuery, rows, role, userId) {
    const { maxPrice, minPrice, minRooms, minSize, categoryFilter, sortBy, keywords } = parseSmartSearchQuery(rawQuery);

    // Nothing usable in the query at all (only filler words, no filters/intent)
    if (
        keywords.length === 0 &&
        maxPrice === null && minPrice === null &&
        minRooms === null && minSize === null &&
        !categoryFilter && !sortBy
    ) {
        return [];
    }

    const scored = rows.map(row => {
        // Role security: landlords only ever see their own listings, same as
        // the regular Browse view.
        const isOwner = (role === 'landlord') ? String(row.user_id) === String(userId) : true;
        if (!isOwner) return null;

        if (maxPrice !== null && Number(row.price) > maxPrice) return null;
        if (minPrice !== null && Number(row.price) < minPrice) return null;
        if (minRooms !== null && Number(row.rooms) < minRooms) return null;
        if (minSize !== null && Number(row.size) < minSize) return null;

        const category = (row.category || "").toLowerCase();
        if (categoryFilter && !category.includes(categoryFilter)) return null;

        const title = (row.title || "").toLowerCase();
        const location = (row.location || "").toLowerCase();
        const amenities = (row.amenities || "").toLowerCase();

        // Weighted relevance: a match in the title matters more than one
        // buried in amenities, which matters more than a generic match.
        let score = 0;
        keywords.forEach(word => {
            if (title.includes(word)) score += 3;
            if (amenities.includes(word)) score += 2;
            if (location.includes(word)) score += 2;
            if (category.includes(word)) score += 1;
        });

        // If the user typed meaningful keywords, require at least one match.
        // If they only used price/room/size/category/sort filters, a score
        // of 0 is fine - the hard filters above already did the work.
        if (keywords.length > 0 && score === 0) return null;

        return { row, score };
    }).filter(Boolean);

    scored.sort((a, b) => {
        if (sortBy === 'price_asc') return (Number(a.row.price) - Number(b.row.price)) || (b.score - a.score);
        if (sortBy === 'price_desc') return (Number(b.row.price) - Number(a.row.price)) || (b.score - a.score);
        if (sortBy === 'size_desc') return (Number(b.row.size || 0) - Number(a.row.size || 0)) || (b.score - a.score);
        return b.score - a.score; // default: best relevance match first
    });

    return scored.map(s => s.row);
}

module.exports = { parseSmartSearchQuery, runSmartSearch };
