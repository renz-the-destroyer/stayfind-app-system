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

// UTILIZATION OF EXPRESS
const app = express();

// MIDDLEWARES
app.use(cors());
// UPDATED: Increased limit to 50mb to allow Base64 image uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// --- NEW: SMART SEARCH ENDPOINT ---
// This handles the AI-like filtering of listings based on chat input
app.post('/api/smart-search', (req, res) => {
    const { message } = req.body;
    
    // Simple logic to extract potential keywords from the user message
    // In a real AI setup, you'd send 'message' to an AI API here.
    // For now, we search the database for matches in title, location, or amenities.
    const searchTerm = `%${message}%`;
    const query = `
        SELECT * FROM listings 
        WHERE title LIKE ? 
        OR location LIKE ? 
        OR amenities LIKE ? 
        OR category LIKE ?
        LIMIT 5
    `;

    db.query(query, [searchTerm, searchTerm, searchTerm, searchTerm], (err, results) => {
        if (err) {
            console.error("Smart Search Error:", err);
            return res.status(500).json({ error: "Search failed" });
        }
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
            if (err) return res.status(500).json(err);
            res.json({ message: "Saved to database" });
        });
    } else {
        const query = "DELETE FROM bookmarks WHERE user_id = ? AND listing_id = ?";
        db.query(query, [userId, listingId], (err, result) => {
            if (err) return res.status(500).json(err);
            res.json({ message: "Removed from database" });
        });
    }
});

// 2. FETCH STORED BOOKMARKS ON LOGIN
app.get('/api/get-bookmarks/:userId', (req, res) => {
    const query = "SELECT listing_id FROM bookmarks WHERE user_id = ?";
    db.query(query, [req.params.userId], (err, results) => {
        if (err) return res.status(500).json(err);
        res.json(results);
    });
});

// --- NEW: EDIT/UPDATE PROPERTY ENDPOINT ---
app.post('/api/update-listing', (req, res) => {
    // UPDATED: Added thumbnail and images to the destructuring to match home.js
    const { listingId, user_id, title, category, price, location, rooms, size, amenities, thumbnail, images } = req.body;

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
            return res.status(500).json(err);
        }
        if (result.affectedRows === 0) {
            return res.status(403).json({ message: "Unauthorized or listing not found" });
        }
        res.json({ success: true, message: "Listing updated successfully!" });
    });
});

// USE ROUTES
app.use('/api', routes);

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
