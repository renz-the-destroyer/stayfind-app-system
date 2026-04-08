const db = require('../config/db');

// 1. GET ALL USERS (Used for Login)
exports.getAllUsers = (req, res) => {
    const sql = "SELECT * FROM users";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 2. CREATE NEW USER (Used for Sign Up)
exports.createUser = (req, res) => {
    const { full_name, email, password, role } = req.body;
    const sql = `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, ?)`;
    db.query(sql, [full_name, email, password, role], (err, result) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Account Created Successfully', id: result.insertId });
    });
};

// 3. UPDATE USER
exports.updateUser = (req, res) => {
    const { id, full_name, email, role } = req.body;
    const sql = `UPDATE users SET full_name = ?, email = ?, role = ? WHERE id = ?`;
    db.query(sql, [full_name, email, role, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'User Updated Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 4. DELETE USER
exports.deleteUser = (req, res) => {
    const { id } = req.body;
    db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'User Deleted Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 5. SEARCH BY ID
exports.getUserById = (req, res) => {
    const id = req.params.id;
    db.query('SELECT * FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 6. UPDATE USER PROFILE
exports.updateProfile = (req, res) => {
    const { full_name, address, contact, role, email } = req.body;

    db.query('SELECT full_name, address, contact, role, updated_at FROM users WHERE email = ?', [email], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = results[0];
        const lastUpdate = user.updated_at ? new Date(user.updated_at) : null;
        const now = new Date();
        const diffInDays = lastUpdate ? Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24)) : 40; 

        const hasActuallyChanged = (newVal, oldVal) => {
            const cleanNew = (newVal || "").toString().trim().toLowerCase();
            const cleanOld = (oldVal || "").toString().trim().toLowerCase();
            return cleanNew !== cleanOld;
        };

        const isChangingPersonalInfo = 
            hasActuallyChanged(full_name, user.full_name) || 
            hasActuallyChanged(address, user.address) || 
            hasActuallyChanged(contact, user.contact);

        console.log(`--- Update Attempt for ${email} ---`);
        const isFirstTimeSetup = (!user.address || user.address.trim() === "") || (!user.contact || user.contact.trim() === "");

        if (!isFirstTimeSetup && isChangingPersonalInfo && diffInDays < 30) {
            return res.status(403).json({ 
                success: false, 
                message: `Personal information can only be changed once every 30 days. Please wait ${30 - diffInDays} more days.` 
            });
        }

        const timestampSQL = isChangingPersonalInfo ? 'updated_at = NOW()' : 'updated_at = updated_at';
        const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ?, ${timestampSQL} WHERE email = ?`;
        
        db.query(sql, [
            full_name || user.full_name, 
            address || user.address, 
            contact || user.contact, 
            role || user.role, 
            email
        ], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Profile updated successfully' });
        });
    });
};

// 7. GET ALL LISTINGS (Strict Landlord Filtering)
exports.getAllListings = (req, res) => {
    const { role, user_id } = req.query;

    let sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email 
        FROM listings l 
        JOIN users u ON l.user_id = u.id`;

    let queryParams = [];

    // Filter logic: If role is landlord, they ONLY see listings where they are the owner
    if (role === 'landlord' && user_id) {
        sql += ` WHERE l.user_id = ?`;
        queryParams.push(user_id);
    }

    sql += ` ORDER BY l.created_at DESC`;
        
    db.query(sql, queryParams, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 8. ADD NEW LISTING
exports.addListing = (req, res) => {
    const { user_id, title, category, price, location, rooms, size, amenities, images, thumbnail } = req.body;
    const sql = `INSERT INTO listings (user_id, title, category, price, location, rooms, size, amenities, images, thumbnail) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const values = [user_id, title, category, price, location, rooms, size, amenities, images, thumbnail];

    db.query(sql, values, (err, result) => {
        if (err) return res.status(500).json({ success: false, error: err.message });
        res.json({ success: true, message: 'Listing Published Successfully', id: result.insertId });
    });
};

// 9. ADD REVIEW (Supports Landlord Replies)
exports.addReview = (req, res) => {
    const { listing_id, user_id, user_name, comment, rating, is_reply } = req.body;
    
    // rating is 0 if it's a landlord reply
    const finalRating = is_reply ? 0 : (rating || 0);
    const finalReplyStatus = is_reply ? 1 : 0;

    const sql = `INSERT INTO reviews (listing_id, user_id, user_name, comment, rating, is_reply) VALUES (?, ?, ?, ?, ?, ?)`;
    
    db.query(sql, [listing_id, user_id, user_name, comment, finalRating, finalReplyStatus], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: finalReplyStatus ? 'Reply submitted!' : 'Review submitted!' });
    });
};

// 10. GET REVIEWS (Ordered by Date)
exports.getReviews = (req, res) => {
    const { listing_id } = req.params;
    // We order by created_at so replies appear in sequence
    const sql = `SELECT * FROM reviews WHERE listing_id = ? ORDER BY created_at ASC`;
    
    db.query(sql, [listing_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 11. DELETE LISTING
exports.deleteListing = (req, res) => {
    const listingId = req.params.id;
    const { user_id } = req.body; 

    const sql = "DELETE FROM listings WHERE id = ? AND user_id = ?";
    
    db.query(sql, [listingId, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Listing deleted successfully' });
        } else {
            res.status(403).json({ success: false, message: 'Unauthorized or Listing not found' });
        }
    });
};

// 12. UPDATE LISTING
exports.updateListing = (req, res) => {
    const { listingId, user_id, title, category, price, location, rooms, size, amenities } = req.body;
    
    const sql = `UPDATE listings SET title = ?, category = ?, price = ?, location = ?, rooms = ?, size = ?, amenities = ? 
                 WHERE id = ? AND user_id = ?`;
    
    db.query(sql, [title, category, price, location, rooms, size, amenities, listingId, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Listing updated successfully' });
        } else {
            res.status(403).json({ success: false, message: 'Unauthorized or listing not found' });
        }
    });
};

// 13. TOGGLE BOOKMARK
exports.toggleBookmark = (req, res) => {
    const { userId, listingId, action } = req.body;

    if (action === 'add') {
        const sql = "INSERT IGNORE INTO bookmarks (user_id, listing_id) VALUES (?, ?)";
        db.query(sql, [userId, listingId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Bookmarked' });
        });
    } else {
        const sql = "DELETE FROM bookmarks WHERE user_id = ? AND listing_id = ?";
        db.query(sql, [userId, listingId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true, message: 'Removed' });
        });
    }
};

// 14. GET BOOKMARKS
exports.getBookmarks = (req, res) => {
    const userId = req.params.id;
    const sql = "SELECT listing_id FROM bookmarks WHERE user_id = ?";
    db.query(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 15. SMART SEARCH - THE ULTIMATE FUZZY VERSION
exports.smartSearch = (req, res) => {
    const userQuery = req.body.message || req.body.query || "";
    
    if (!userQuery.trim()) {
        return res.json({ success: true, results: [] });
    }

    // Linisin ang input at kunin ang mga keywords
    const words = userQuery.toLowerCase().trim().split(/\s+/).filter(w => 
        w.length > 1 && !['near', 'sa', 'na', 'the', 'an', 'with', 'and', 'for'].includes(w)
    );

    let sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email 
        FROM listings l 
        LEFT JOIN users u ON l.user_id = u.id 
        WHERE `;
    
    let conditions = [];
    let params = [];

    if (words.length > 0) {
        // Imbes na isang CONCAT, gagawa tayo ng hiwalay na check para sa BAWAT salita
        words.forEach(word => {
            conditions.push(`(
                LOWER(l.title) LIKE ? OR 
                LOWER(l.location) LIKE ? OR 
                LOWER(l.category) LIKE ? OR 
                LOWER(l.amenities) LIKE ?
            )`);
            const term = `%${word}%`;
            params.push(term, term, term, term);
        });
        
        // Gagamit tayo ng AND sa pagitan ng keywords
        // Ibig sabihin: (Dapat mahanap ang Word1 kahit saan) AND (Dapat mahanap ang Word2 kahit saan)
        sql += conditions.join(" AND ");
    } else {
        sql += "1=1"; 
    }

    sql += " ORDER BY l.id DESC";

    db.query(sql, params, (err, rows) => {
        if (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ 
            success: true, 
            results: rows,
            debug: { query: userQuery, words_detected: words } 
        });
    });
};
