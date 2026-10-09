// controllers/searchController.js
//
// POST /api/smart-search/suggestions
// Body: { message: "house under 3000 with wifi", userContext: { role, id } }
// Returns: { success: true, suggestions: [{ label, query, count }, ...] }
//
// Only called by the frontend AFTER a Smart Search found nothing. It re-runs
// the query with one constraint loosened at a time (see suggestFallbacks in
// utils/smartSearchLogic.js) and returns only the loosened versions that
// actually find something.

const db = require('../config/db');
const { suggestFallbacks } = require('../utils/smartSearchLogic');

exports.smartSearchSuggestions = (req, res) => {
    const userQuery = req.body.message || "";
    const { role, id: userId } = req.body.userContext || {};

    // Only the columns the matcher reads. Deliberately NOT l.* so we don't
    // pull every listing's photo URLs/base64 just to count matches.
    const sql = `
        SELECT l.id, l.user_id, l.title, l.category, l.price, l.location,
               l.rooms, l.size, l.amenities
        FROM listings l
    `;

    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        const suggestions = suggestFallbacks(userQuery, rows, role, userId);
        res.json({ success: true, suggestions });
    });
};
