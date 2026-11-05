// utils/smartSearchLogic.js
//
// Shared "Smart Search" query parser + matcher, used by BOTH:
//  - controllers/userController.js's smartSearch export (POST /api/smart-search)
//  - controllers/searchController.js's smartSearchSuggestions export
//    (POST /api/smart-search/suggestions) - powers the zero-result nudge
//
// Exported functions: parseSmartSearchQuery and runSmartSearch keep the exact
// same signatures as before, so userController.js needs NO changes.
// Also exports: suggestFallbacks(rawQuery, rows, role, userId).
//
// ============================================================================
// WHAT THIS UNDERSTANDS
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
//
// FIXED earlier: price / room / size phrases ("under 5000", "3 bedrooms",
// "30 sqm") are removed from the text before it is split into keywords.
//
// FIXED in this version:
//   1. Typos in the property type ("bedsapce", "aparment") are now corrected
//      BEFORE the category check, so they become a hard category filter
//      instead of an ordinary keyword.
//   2. Keywords are now matched with AND (every keyword must match somewhere
//      in title / location / amenities / category). Before, matching ONE
//      keyword was enough, so "bedspace in malabanban sur" also returned
//      bedspaces from other places.
// ============================================================================

// ---------------------------------------------------------------------------
// 1. STOPWORDS
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
    // Conversational filler
    'can', 'you', 'show', 'me', 'find', 'looking', 'need', 'want', 'give', 'get',
    'search', 'searching', 'please', 'pls', 'there', 'any', 'some', 'i', 'im', "i'm",
    // Price/size comparison leftovers + generic nouns
    'under', 'below', 'above', 'over', 'less', 'than', 'more', 'higher', 'hanggang',
    'pababa', 'pataas', 'or', 'and', 'php', 'sqm',
    'room', 'rooms', 'unit', 'place', 'property', 'stay', 'stays', 'rent', 'rental', 'upa'
]);

// ---------------------------------------------------------------------------
// 2. PROPERTY TYPE DETECTION (hard filter, not a fuzzy keyword)
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
// ---------------------------------------------------------------------------
const SYNONYMS = {
    'wifi': 'wifi', 'internet': 'wifi', 'wai-fi': 'wifi',
    'aircon': 'aircon', 'ac': 'aircon', 'aircondition': 'aircon', 'airconditioned': 'aircon',
    'parking': 'parking', 'carpark': 'parking', 'paradahan': 'parking',
    'kitchen': 'kitchen', 'ketchen': 'kitchen',
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
// ---------------------------------------------------------------------------
const CHEAP_TERMS = new Set(['cheap', 'cheapest', 'mura', 'pinakamura', 'murang', 'budget', 'affordable']);
const EXPENSIVE_TERMS = new Set(['expensive', 'mahal', 'pinakamahal', 'premium', 'luxury', 'luxurious']);
const BIG_TERMS = new Set(['big', 'biggest', 'large', 'malaki', 'pinakamalaki', 'spacious', 'maluwag', 'malawak']);

// ---------------------------------------------------------------------------
// 5. TYPO-TOLERANCE (fuzzy matching)
// Only runs on words 4+ letters long so short, legitimate location keywords
// (like "eu", "up", "sur") never get mangled.
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
                dp[i - 1][j] + 1,       // deletion
                dp[i][j - 1] + 1,       // insertion
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
// ---------------------------------------------------------------------------
function parseSmartSearchQuery(rawQuery) {
    const lowerQuery = (rawQuery || "").toLowerCase().trim();

    // Working copy: every phrase turned into a filter below (price / rooms /
    // size) is cut out of this copy so its leftover words never become keywords.
    let working = lowerQuery;

    // --- PRICE FILTERS: "under 5000", "below ₱5k", "5k pababa", "over 3000" ---
    let maxPrice = null, minPrice = null;

    const underMatch =
        lowerQuery.match(/(?:under|below|less than|hanggang)\s*(?:₱|php)?\s*([\d,]+)(k)?/) ||
        lowerQuery.match(/([\d,]+)(k)?\s*(?:pababa|or less|and below)/);
    if (underMatch) {
        maxPrice = parseInt(underMatch[1].replace(/,/g, ''), 10) * (underMatch[2] ? 1000 : 1);
        working = working.replace(underMatch[0], ' ');
    }

    const overMatch =
        lowerQuery.match(/(?:above|over|more than|higher than|pataas)\s*(?:₱|php)?\s*([\d,]+)(k)?/) ||
        lowerQuery.match(/([\d,]+)(k)?\s*(?:pataas|or more|and above)/);
    if (overMatch) {
        minPrice = parseInt(overMatch[1].replace(/,/g, ''), 10) * (overMatch[2] ? 1000 : 1);
        working = working.replace(overMatch[0], ' ');
    }

    // --- ROOM COUNT FILTER: "3 rooms", "2 bedrooms", "3 kwarto" ---
    let minRooms = null;
    const roomMatch = lowerQuery.match(/(\d+)\s*(?:rooms?|bedrooms?|kwarto|kuarto)/);
    if (roomMatch) {
        minRooms = parseInt(roomMatch[1], 10);
        working = working.replace(roomMatch[0], ' ');
    }

    // --- SIZE FILTER: "30 sqm", "at least 25 sq m", "30 square meters" ---
    let minSize = null;
    const sizeMatch = lowerQuery.match(/(\d+)\s*(?:sqm|sq\.?\s?m\.?|square\s?meters?)/);
    if (sizeMatch) {
        minSize = parseInt(sizeMatch[1], 10);
        working = working.replace(sizeMatch[0], ' ');
    }

    // --- TOKENIZE (from the cleaned-up working copy, not the raw query) ---
    const rawWords = working.split(/\s+/).filter(w => w.length > 1);

    // --- PROPERTY TYPE: pulled out as a hard filter, not a soft keyword ---
    // FIX: typo-tolerant. "bedsapce" -> "bedspace", "aparment" -> "apartment"
    // BEFORE checking the category table.
    let categoryFilter = null;
    const afterCategory = [];
    for (const word of rawWords) {
        const corrected = CATEGORY_TERMS[word] ? word : fuzzyCorrect(word);
        if (!categoryFilter && CATEGORY_TERMS[corrected]) {
            categoryFilter = CATEGORY_TERMS[corrected];
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
// Filters rows against an ALREADY-PARSED query, scores each surviving row by
// weighted relevance, then sorts - either by the detected sort intent
// (cheapest/biggest/etc.) or by relevance score.
//
// Split out of runSmartSearch() so suggestFallbacks() below can re-run the
// same matching against "relaxed" versions of a parsed query.
// ---------------------------------------------------------------------------
function applyParsedSearch(parsed, rows, role, userId) {
    const { maxPrice, minPrice, minRooms, minSize, categoryFilter, sortBy, keywords } = parsed;

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
        // Role security: landlords only ever see their own listings.
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

        // Weighted relevance: title > amenities/location > category.
        // FIX: track whether EVERY keyword matched somewhere (AND logic).
        let score = 0;
        let matchedAll = true;
        keywords.forEach(word => {
            let hit = false;
            if (title.includes(word)) { score += 3; hit = true; }
            if (amenities.includes(word)) { score += 2; hit = true; }
            if (location.includes(word)) { score += 2; hit = true; }
            if (category.includes(word)) { score += 1; hit = true; }
            if (!hit) matchedAll = false;
        });

        // Every keyword must match somewhere. Price/room/size/category/sort
        // filters were already applied above.
        if (keywords.length > 0 && !matchedAll) return null;

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

// Same signature and behavior as before - parse, then match.
function runSmartSearch(rawQuery, rows, role, userId) {
    return applyParsedSearch(parseSmartSearchQuery(rawQuery), rows, role, userId);
}

// ---------------------------------------------------------------------------
// 8. ZERO-RESULT FALLBACKS
// When a query finds nothing, re-run it with one constraint loosened at a
// time and return only the loosened versions that actually find something.
// At most 3 are returned, ordered from "loosest change" to "biggest change".
// ---------------------------------------------------------------------------
function buildQueryFromParsed(p) {
    const parts = [];
    if (p.sortBy === 'price_asc') parts.push('cheapest');
    if (p.sortBy === 'price_desc') parts.push('mahal');
    if (p.sortBy === 'size_desc') parts.push('biggest');
    if (p.categoryFilter) parts.push(p.categoryFilter);
    // "pet friendly" has a space, but the parser splits on spaces - the
    // joined form "petfriendly" maps back to it through SYNONYMS.
    p.keywords.forEach(k => parts.push(k.replace(/\s+/g, '')));
    if (p.maxPrice !== null) parts.push(`under ${p.maxPrice}`);
    if (p.minPrice !== null) parts.push(`over ${p.minPrice}`);
    if (p.minRooms !== null) parts.push(`${p.minRooms} rooms`);
    if (p.minSize !== null) parts.push(`${p.minSize} sqm`);
    return parts.join(' ');
}

function suggestFallbacks(rawQuery, rows, role, userId) {
    const parsed = parseSmartSearchQuery(rawQuery);
    const variants = [];

    const hasPrice = parsed.maxPrice !== null || parsed.minPrice !== null;
    const hasRooms = parsed.minRooms !== null;
    const hasSize = parsed.minSize !== null;
    const hasKeywords = parsed.keywords.length > 0;
    const hasCategory = !!parsed.categoryFilter;

    if (hasPrice) {
        const budget = parsed.maxPrice !== null ? ` (over ₱${parsed.maxPrice.toLocaleString()})` : '';
        variants.push({ label: `Ignore the price limit${budget}`, patch: { maxPrice: null, minPrice: null } });
    }
    if (hasRooms) variants.push({ label: 'Any number of rooms', patch: { minRooms: null } });
    if (hasSize) variants.push({ label: 'Any size', patch: { minSize: null } });
    if (hasKeywords && (hasCategory || hasPrice || hasRooms || hasSize)) {
        variants.push({ label: `Skip "${parsed.keywords.join(', ')}"`, patch: { keywords: [] } });
    }
    if (hasCategory && hasKeywords) {
        variants.push({ label: 'Any property type', patch: { categoryFilter: null } });
    }

    // Last resort: when several things are set, keep only the property type.
    const constraintCount = [hasPrice, hasRooms, hasSize, hasKeywords].filter(Boolean).length;
    if (hasCategory && constraintCount >= 2) {
        variants.push({
            label: `Just show ${parsed.categoryFilter}s`,
            patch: { maxPrice: null, minPrice: null, minRooms: null, minSize: null, keywords: [] }
        });
    }

    const seenQueries = new Set();
    const suggestions = [];
    for (const variant of variants) {
        const relaxed = { ...parsed, ...variant.patch };
        const query = buildQueryFromParsed(relaxed);
        if (!query || seenQueries.has(query)) continue;

        const found = applyParsedSearch(relaxed, rows, role, userId);
        if (found.length === 0) continue;

        seenQueries.add(query);
        suggestions.push({ label: variant.label, query, count: found.length });
        if (suggestions.length >= 3) break;
    }

    return suggestions;
}

module.exports = { parseSmartSearchQuery, runSmartSearch, suggestFallbacks };
