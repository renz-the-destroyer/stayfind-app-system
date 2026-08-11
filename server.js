// API FRAMEWORK
const express = require('express');
// CROSS ORIGIN RESOURCE SHARING
const cors = require('cors');
// ENVIRONMENT VARIABLES
require('dotenv').config();
// DATABASE CONNECTION
const db = require('./config/db');
// ROUTES
const routes = require('./routes/index.js');
// NEW: Admin routes (separate router, protected by ADMIN_KEY)
const adminRoutes = require('./routes/adminRoutes');
// NEW: Shared Taglish-aware Smart Search logic (see utils/smartSearchLogic.js).
// Used here AND in controllers/userController.js so both stay in sync.
const { runSmartSearch } = require('./utils/smartSearchLogic');

// UTILIZATION OF EXPRESS
const app = express();

// MIDDLEWARES
app.use(cors());
// UPDATED: Increased limit to 50mb to allow Base64 image uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- UPDATED: SMART SEARCH ENDPOINT ---
// This handles the AI-like filtering of listings based on chat input.
//
// UPDATED: This used to be a plain SQL LIKE '%message%' match against the
// WHOLE typed phrase, which meant a query like "house malapit sa eu" was
// searched for as one literal string "house malapit sa eu" - something that
// obviously never appears in any listing's text, so it almost always
// returned zero results. It also completely ignored landlord/tenant role
// scoping, so a landlord could see every user's listings through Smart
// Search (inconsistent with the regular Browse view).
//
// Now it fetches all listings (with landlord info joined, same as the normal
// /view endpoint) and hands them to the shared runSmartSearch() helper,
// which strips Tagalog/English filler words ("malapit", "sa", "na", "may"),
// translates common Taglish terms ("bahay" -> "house", "kwarto" -> "bedspace",
// "parking"/"paradahan" -> "parking", "ketchen" -> "kitchen"), understands
// price/room filters ("under 5000", "3 rooms"), and ranks results by how many
// meaningful keywords actually matched.
app.post('/api/smart-search', (req, res) => {
    const { message, userContext } = req.body;
    const role = userContext?.role;
    const userId = userContext?.id;

    const query = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email
        FROM listings l
        LEFT JOIN users u ON l.user_id = u.id
    `;

    db.query(query, (err, rows) => {
        if (err) {
            console.error("Smart Search Error:", err);
            return res.status(500).json({ error: "Search failed" });
        }

        const results = runSmartSearch(message, rows, role, userId);
        res.json({ results });
    });
});

// --- NEW: BOOKMARK ENDPOINTS (Added directly to server.js for persistence) ---

// 1. SAVE OR REMOVE BOOKMARK
app.post('/api/toggle-bookmark', (req, res) => {
    const { userId, listingId, action } = req.body;
    
    if (action === 'add') {
        const query = "INSERT IGNORE INTO bookmarks (user_id, listing_id) VALUES (?, ?)";
        db.query(query, [userId, listingId], (err, result) => {
            // FIX: Error objects don't serialize their .message via JSON.stringify,
            // so res.json(err) was silently sending "{}" to the frontend. Now we
            // explicitly pull out the message so real DB errors are visible.
            if (err) return res.status(500).json({ error: err.message, message: err.message });
            res.json({ message: "Saved to database" });
        });
    } else {
        const query = "DELETE FROM bookmarks WHERE user_id = ? AND listing_id = ?";
        db.query(query, [userId, listingId], (err, result) => {
            // FIX: same serialization issue as above.
            if (err) return res.status(500).json({ error: err.message, message: err.message });
            res.json({ message: "Removed from database" });
        });
    }
});

// 2. FETCH STORED BOOKMARKS ON LOGIN
app.get('/api/get-bookmarks/:userId', (req, res) => {
    const query = "SELECT listing_id FROM bookmarks WHERE user_id = ?";
    db.query(query, [req.params.userId], (err, results) => {
        // FIX: same serialization issue as above.
        if (err) return res.status(500).json({ error: err.message, message: err.message });
        res.json(results);
    });
});

// --- NEW: EDIT/UPDATE PROPERTY ENDPOINT ---
app.post('/api/update-listing', (req, res) => {
    // UPDATED: Added thumbnail and images to the destructuring to match home.js
    const { listingId, user_id, title, category, price, location, rooms, size, amenities, thumbnail, images } = req.body;

    // NEW: Friendly guard for oversized photo payloads. Managed MySQL hosts
    // (like Clever Cloud's free tier) often cap max_allowed_packet well below
    // our 50mb express body limit, so a very large combined image payload can
    // fail at the DB layer. This gives a clear message instead of a silent
    // crash. Adjust the 15 (MB) threshold if your DB plan allows more.
    if (images) {
        const approxSizeMB = Buffer.byteLength(images, 'utf8') / (1024 * 1024);
        if (approxSizeMB > 15) {
            return res.status(413).json({
                success: false,
                message: `Your photos are too large combined (~${approxSizeMB.toFixed(1)}MB). Please use fewer photos or smaller images.`
            });
        }
    }

    // UPDATED: The SQL now handles image updates if they are provided
    const query = `
        UPDATE listings 
        SET title=?, category=?, price=?, location=?, rooms=?, size=?, amenities=?, 
            thumbnail = COALESCE(?, thumbnail), 
            images = COALESCE(?, images)
        WHERE id=? AND user_id=?
    `;

    db.query(query, [title, category, price, location, rooms, size, amenities, thumbnail, images, listingId, user_id], (err, result) => {
        if (err) {
            console.error("Update Error:", err);
            // FIX: Error objects don't serialize their .message via JSON.stringify,
            // so res.json(err) was silently sending "{}" to the frontend and hiding
            // the real reason (e.g. "Data too long for column 'images'" if the
            // images/thumbnail columns are still TEXT instead of LONGTEXT).
            return res.status(500).json({ error: err.message, message: err.message });
        }
        if (result.affectedRows === 0) {
            return res.status(403).json({ message: "Unauthorized or listing not found" });
        }
        res.json({ success: true, message: "Listing updated successfully!" });
    });
});

// USE ROUTES
app.use('/api', routes);
// NEW: Mount admin routes under /api/admin. Anything hitting
// /api/admin/login, /api/admin/stats, /api/admin/users, etc. is handled by
// adminRoutes.js -> adminController.js. This is what admin.js's API_BASE
// ("https://stayfind-app-system.onrender.com/api/admin") depends on.
app.use('/api/admin', adminRoutes);

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// PORT SETTING
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
