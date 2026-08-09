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
// UPDATED: Landlord approval gate. Picking "Landlord" no longer sets role =
// 'landlord' directly — it now REQUIRES 3 verification documents
// (landlord_documents) and flips landlord_status to 'pending', which shows
// up in the Admin Panel's "Landlord Requests" tab along with the uploaded
// documents for review. Only the admin's approve action (in
// adminController.js) actually sets role = 'landlord'. The original 30-day
// personal-info lock logic below is untouched.
exports.updateProfile = (req, res) => {
    const { full_name, address, contact, role, email, landlord_documents } = req.body;

    db.query('SELECT full_name, address, contact, role, landlord_status, landlord_documents, updated_at FROM users WHERE email = ?', [email], (err, results) => {
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

        // NEW: Landlord approval gate logic.
        // - If the user already has an approved landlord_status, letting them
        //   keep/select 'landlord' is fine (they were approved previously) —
        //   no documents required again.
        // - Otherwise, selecting 'landlord' does NOT grant the role. It
        //   REQUIRES landlord_documents (3 base64 images joined by '|||')
        //   before it will even flip landlord_status to 'pending'. Without
        //   documents, the request is rejected outright with a 400.
        let finalRole = role || user.role;
        let finalLandlordStatus = user.landlord_status || 'none';
        let finalLandlordDocs = user.landlord_documents; // unchanged by default

        if (role === 'landlord') {
            if (user.landlord_status === 'approved') {
                finalRole = 'landlord';
            } else {
                // NEW: require documents for any fresh (non-approved) landlord request
                if (!landlord_documents || landlord_documents.trim() === "") {
                    return res.status(400).json({
                        success: false,
                        message: 'Please upload all 3 required landlord verification documents (Proof of Ownership, Local Permits, BIR Registration) before submitting your request.'
                    });
                }

                // NEW: basic sanity check the payload isn't absurdly oversized
                // for the DB (same pattern as listing image guards elsewhere).
                const approxSizeMB = Buffer.byteLength(landlord_documents, 'utf8') / (1024 * 1024);
                if (approxSizeMB > 20) {
                    return res.status(413).json({
                        success: false,
                        message: `Your documents are too large combined (~${approxSizeMB.toFixed(1)}MB). Please use smaller/clearer photos.`
                    });
                }

                finalRole = 'tenant';
                finalLandlordStatus = 'pending';
                finalLandlordDocs = landlord_documents;
            }
        }

        const timestampSQL = isChangingPersonalInfo ? 'updated_at = NOW()' : 'updated_at = updated_at';
        const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ?, landlord_status = ?, landlord_documents = ?, ${timestampSQL} WHERE email = ?`;
        
        db.query(sql, [
            full_name || user.full_name, 
            address || user.address, 
            contact || user.contact, 
            finalRole,
            finalLandlordStatus,
            finalLandlordDocs,
            email
        ], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            // NEW: role and landlord_status are sent back so the frontend
            // (dashboard.js / home.js) knows the REAL outcome instead of
            // assuming whatever the user picked was granted.
            res.json({ 
                success: true, 
                message: (role === 'landlord' && finalLandlordStatus === 'pending')
                    ? 'Landlord request and documents submitted! Waiting for admin approval.'
                    : 'Profile updated successfully',
                role: finalRole,
                landlord_status: finalLandlordStatus
            });
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

    // NEW: Friendly guard for oversized photo payloads, matching the one added
    // to /api/update-listing in server.js. Managed MySQL hosts (like Clever
    // Cloud's free tier) often cap max_allowed_packet well below our 50mb
    // express body limit, so a very large combined image payload can fail at
    // the DB layer. This gives a clear message instead of a silent crash.
    if (images) {
        const approxSizeMB = Buffer.byteLength(images, 'utf8') / (1024 * 1024);
        if (approxSizeMB > 15) {
            return res.status(413).json({
                success: false,
                message: `Your photos are too large combined (~${approxSizeMB.toFixed(1)}MB). Please use fewer photos or smaller images.`,
                error: `Payload too large (~${approxSizeMB.toFixed(1)}MB)`
            });
        }
    }

    const sql = `INSERT INTO listings (user_id, title, category, price, location, rooms, size, amenities, images, thumbnail) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const values = [user_id, title, category, price, location, rooms, size, amenities, images, thumbnail];

    db.query(sql, values, (err, result) => {
        // FIX: now also included as `message` (in addition to the existing
        // `error` field) since home.js reads `errResult.message` when showing
        // the failure popup. Previously the real DB error (e.g. "Data too long
        // for column 'images'" if the column is still TEXT instead of
        // LONGTEXT) was silently swallowed and the user only saw a generic
        // "Failed to post" alert.
        if (err) return res.status(500).json({ success: false, error: err.message, message: err.message });
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
// NOTE: This function is currently NOT the one actually handling
// POST /api/update-listing at runtime — server.js registers its own inline
// handler for that exact path BEFORE `app.use('/api', routes)` is mounted,
// so Express matches server.js's handler first and this one is effectively
// unreachable dead code. Left in place and fixed anyway (per "do not remove
// code") in case you later remove the inline handler in server.js and want
// to route update-listing through this controller instead.
exports.updateListing = (req, res) => {
    const { listingId, user_id, title, category, price, location, rooms, size, amenities } = req.body;
    
    const sql = `UPDATE listings SET title = ?, category = ?, price = ?, location = ?, rooms = ?, size = ?, amenities = ? 
                 WHERE id = ? AND user_id = ?`;
    
    db.query(sql, [title, category, price, location, rooms, size, amenities, listingId, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message, message: err.message });
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

// 15. userController.js - Updated Smart Search with Role Security
exports.smartSearch = (req, res) => {
    const userQuery = req.body.message || "";
    // Access user info from the request (sent from frontend)
    const { role, id: userId } = req.body.userContext || {}; 
    
    const keywords = userQuery.toLowerCase().trim().split(/\s+/).filter(w => w.length > 1);

    if (keywords.length === 0) return res.json({ success: true, results: [] });

    // Step 1: Base SQL Query
    let sql = `
        SELECT l.*, u.full_name AS landlord_name 
        FROM listings l 
        LEFT JOIN users u ON l.user_id = u.id
    `;

    // Step 2: Role Filtering logic
    // If landlord, they only see their own items. If tenant, they see all.
    let roleCondition = (role === 'landlord') ? `l.user_id = ${db.escape(userId)}` : `1=1`;

    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const finalResults = rows.filter(row => {
            // Role Check: Ensure landlords only see their own listings in search
            const isOwner = (role === 'landlord') ? String(row.user_id) === String(userId) : true;
            if (!isOwner) return false;

            const allTextInRow = `${row.title} ${row.location} ${row.category} ${row.amenities}`.toLowerCase();
            return keywords.every(word => allTextInRow.includes(word));
        });

        res.json({ success: true, results: finalResults });
    });
};
