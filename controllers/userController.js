const db = require('../config/db');
// NEW: Shared Taglish-aware Smart Search logic (see utils/smartSearchLogic.js).
// Used here AND in server.js so both stay in sync.
const { runSmartSearch } = require('../utils/smartSearchLogic');

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
// 'landlord' directly — it now REQUIRES 4 verification items
// (landlord_documents: Proof of Ownership, Local Permits, BIR Registration,
// and a Selfie holding valid ID — all 4 base64 images joined by '|||', in
// that exact order) PLUS landlord_doc_name (the name the applicant typed as
// "printed on their Proof of Ownership document", used by the admin panel
// for a name cross-check against the registered full_name). Submitting a
// fresh request flips landlord_status to 'pending', which shows up in the
// Admin Panel's "Landlord Requests" tab along with the uploaded documents
// and the name-match indicator for review. Only the admin's approve action
// (in adminController.js) actually sets role = 'landlord'. The original
// 30-day personal-info lock logic below is untouched.
exports.updateProfile = (req, res) => {
    const { full_name, address, contact, role, email, landlord_documents, landlord_doc_name } = req.body;

    db.query('SELECT full_name, address, contact, role, landlord_status, landlord_documents, landlord_doc_name, updated_at FROM users WHERE email = ?', [email], (err, results) => {
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
        const isLockedOut = !isFirstTimeSetup && isChangingPersonalInfo && diffInDays < 30;

        // UPDATED: Decoupled the 30-day personal-info lock from landlord
        // verification requests. Previously, ANY submission that touched
        // full_name/address/contact while locked was rejected outright —
        // including a landlord request, since dashboard.html/home.js resend
        // those same 3 fields alongside the documents every time. That meant
        // a returning user requesting landlord status got blocked by this
        // lock even though they never intended to edit their personal info,
        // just because the retyped text didn't match the stored value
        // character-for-character.
        //
        // Now:
        // - A PLAIN personal-info edit (role isn't 'landlord') still gets
        //   blocked exactly as before if locked — that protection is intact.
        // - A LANDLORD REQUEST (role === 'landlord', not yet approved) is
        //   NEVER blocked by this lock. If locked, we simply ignore the
        //   full_name/address/contact values in this submission (keep the
        //   existing ones) and still process the role/documents normally.
        if (isLockedOut && role !== 'landlord') {
            return res.status(403).json({ 
                success: false, 
                message: `Personal information can only be changed once every 30 days. Please wait ${30 - diffInDays} more days.` 
            });
        }

        // NEW: when locked but this IS a landlord request, fall back to the
        // user's existing personal info instead of whatever was retyped in
        // the form, so the UPDATE below can't silently change it either.
        const effectiveFullName = isLockedOut ? user.full_name : (full_name || user.full_name);
        const effectiveAddress = isLockedOut ? user.address : (address || user.address);
        const effectiveContact = isLockedOut ? user.contact : (contact || user.contact);

        // NEW: Landlord approval gate logic.
        // - If the user already has an approved landlord_status, letting them
        //   keep/select 'landlord' is fine (they were approved previously) —
        //   no documents required again.
        // - Otherwise, selecting 'landlord' does NOT grant the role. It
        //   REQUIRES landlord_documents (4 base64 images joined by '|||':
        //   ownership, permits, BIR, selfie-with-ID) AND landlord_doc_name
        //   (the applicant's typed "name on document", used for the admin
        //   panel's name cross-check) before it will even flip
        //   landlord_status to 'pending'. Without either, the request is
        //   rejected outright with a 400.
        let finalRole = role || user.role;
        let finalLandlordStatus = user.landlord_status || 'none';
        let finalLandlordDocs = user.landlord_documents; // unchanged by default
        let finalDocName = user.landlord_doc_name; // unchanged by default

        if (role === 'landlord') {
            if (user.landlord_status === 'approved') {
                finalRole = 'landlord';
            } else {
                // NEW: require documents for any fresh (non-approved) landlord request
                if (!landlord_documents || landlord_documents.trim() === "") {
                    return res.status(400).json({
                        success: false,
                        message: 'Please upload all 4 required landlord verification items (Proof of Ownership, Local Permits, BIR Registration, and a Selfie with valid ID) before submitting your request.'
                    });
                }

                // NEW: require the typed owner name for the admin's name cross-check
                if (!landlord_doc_name || landlord_doc_name.trim() === "") {
                    return res.status(400).json({
                        success: false,
                        message: 'Please provide the name shown on your Proof of Ownership document.'
                    });
                }

                // NEW: basic sanity check the payload isn't absurdly oversized
                // for the DB (same pattern as listing image guards elsewhere).
                // Raised slightly from the original 20MB to 25MB now that a
                // 4th image (the ID selfie) is included in the same combined
                // payload.
                const approxSizeMB = Buffer.byteLength(landlord_documents, 'utf8') / (1024 * 1024);
                if (approxSizeMB > 25) {
                    return res.status(413).json({
                        success: false,
                        message: `Your documents are too large combined (~${approxSizeMB.toFixed(1)}MB). Please use smaller/clearer photos.`
                    });
                }

                finalRole = 'tenant';
                finalLandlordStatus = 'pending';
                finalLandlordDocs = landlord_documents;
                finalDocName = landlord_doc_name.trim();
            }
        }

        // NEW: only bump updated_at if the personal info actually got applied
        // this time (i.e. NOT skipped due to the lock). If we ignored the
        // retyped info because of isLockedOut, the original updated_at should
        // keep counting down to the same 30-day mark as before — otherwise a
        // landlord request would keep resetting the timer forever and the
        // lock would never actually expire.
        const timestampSQL = (isChangingPersonalInfo && !isLockedOut) ? 'updated_at = NOW()' : 'updated_at = updated_at';
        const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ?, landlord_status = ?, landlord_documents = ?, landlord_doc_name = ?, ${timestampSQL} WHERE email = ?`;
        
        db.query(sql, [
            effectiveFullName,
            effectiveAddress,
            effectiveContact,
            finalRole,
            finalLandlordStatus,
            finalLandlordDocs,
            finalDocName,
            email
        ], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });

            // NEW: build a message that also tells the user if their
            // personal-info edits were skipped this time because of the lock,
            // so they aren't confused about why their retyped address/contact
            // didn't seem to "stick."
            let message;
            if (role === 'landlord' && finalLandlordStatus === 'pending') {
                message = isLockedOut
                    ? `Landlord request and documents submitted! (Note: your personal info edits were not applied — you can change those again in ${30 - diffInDays} more days.) Waiting for admin approval.`
                    : 'Landlord request and documents submitted! Waiting for admin approval.';
            } else {
                message = 'Profile updated successfully';
            }

            // NEW: role and landlord_status are sent back so the frontend
            // (dashboard.js / home.js) knows the REAL outcome instead of
            // assuming whatever the user picked was granted.
            res.json({ 
                success: true, 
                message,
                role: finalRole,
                landlord_status: finalLandlordStatus
            });
        });
    });
};

// 7. GET ALL LISTINGS (Strict Landlord Filtering)
// UPDATED: each row now also carries avg_rating and review_count, computed
// with two correlated subqueries against the reviews table:
//   - avg_rating: the mean of `rating` across rows that actually have a star
//     rating (rating > 0), so text-only comments and landlord replies
//     (rating = 0) never drag the average down. COALESCE'd to 0 for
//     listings with no ratings yet.
//   - review_count: the total number of rows in `reviews` for this listing
//     (matches what the details modal already shows via revCount, which
//     uses reviews.length from GET /get-reviews/:listing_id - comments and
//     replies both count there too).
// home.js's renderListings() reads these two fields to show the star-average
// pill and comment-count badge on each card without any extra network calls.
exports.getAllListings = (req, res) => {
    const { role, user_id } = req.query;

    let sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email,
            COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.listing_id = l.id AND r.rating > 0), 0) AS avg_rating,
            (SELECT COUNT(*) FROM reviews r WHERE r.listing_id = l.id) AS review_count
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
// UPDATED: now also accepts/saves `status` ('available' | 'occupied'), used
// by the new Available/Occupied filter buttons on home.html. Defaults to
// 'available' if not sent or sent as anything unrecognized, so old
// callers/clients that don't know about this field still work fine.
exports.addListing = (req, res) => {
    const { user_id, title, category, price, location, rooms, size, amenities, images, thumbnail, status } = req.body;
    const finalStatus = (status === 'occupied') ? 'occupied' : 'available';

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

    const sql = `INSERT INTO listings (user_id, title, category, price, location, rooms, size, amenities, images, thumbnail, status) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const values = [user_id, title, category, price, location, rooms, size, amenities, images, thumbnail, finalStatus];

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
// UPDATED: this is now THE live handler for POST /api/update-listing. It
// used to be shadowed by an inline handler registered directly on `app` in
// server.js (Express matches whichever handler was registered first, and
// that one was registered before `app.use('/api', routes)` mounted this
// controller) - that duplicate has been removed from server.js so there is
// only one place to maintain this logic going forward.
// This version is brought up to full parity with what the removed inline
// handler did, which this controller's version previously did NOT do:
//   - accepts thumbnail/images and writes them with COALESCE(?, column) so
//     a save that didn't pick new photos leaves the existing ones untouched
//     (home.js sends null for these when nothing new was selected)
//   - guards against an oversized combined photo payload (>15MB), same
//     threshold used in addListing() above and in the removed inline handler
exports.updateListing = (req, res) => {
    const { listingId, user_id, title, category, price, location, rooms, size, amenities, status, thumbnail, images } = req.body;
    const finalStatus = (status === 'occupied') ? 'occupied' : 'available';

    if (images) {
        const approxSizeMB = Buffer.byteLength(images, 'utf8') / (1024 * 1024);
        if (approxSizeMB > 15) {
            return res.status(413).json({
                success: false,
                message: `Your photos are too large combined (~${approxSizeMB.toFixed(1)}MB). Please use fewer photos or smaller images.`
            });
        }
    }

    const sql = `UPDATE listings 
                 SET title = ?, category = ?, price = ?, location = ?, rooms = ?, size = ?, amenities = ?, status = ?,
                     thumbnail = COALESCE(?, thumbnail),
                     images = COALESCE(?, images)
                 WHERE id = ? AND user_id = ?`;

    db.query(sql, [title, category, price, location, rooms, size, amenities, finalStatus, thumbnail, images, listingId, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message, message: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Listing updated successfully!' });
        } else {
            res.status(403).json({ success: false, message: 'Unauthorized or listing not found' });
        }
    });
};

// 13. TOGGLE BOOKMARK
// UPDATED: this is now THE live handler for POST /api/toggle-bookmark - the
// inline duplicate registered directly on `app` in server.js has been
// removed (same shadowing issue described on updateListing() above).
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
// UPDATED: this is now THE live handler for GET /api/get-bookmarks/:id -
// same shadowing issue as toggleBookmark() above, now resolved.
exports.getBookmarks = (req, res) => {
    const userId = req.params.id;
    const sql = "SELECT listing_id FROM bookmarks WHERE user_id = ?";
    db.query(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 15. SMART SEARCH (Taglish-aware, with Role Security)
// UPDATED: this is now THE live handler for POST /api/smart-search, for the
// same reason described on updateListing() above - the inline duplicate in
// server.js that used to shadow this has been removed. Shares its parsing/
// scoring logic with the old inline version via utils/smartSearchLogic.js
// (they were kept in sync even while this one was dead code), and also
// carries the avg_rating/review_count subqueries so Smart Search cards get
// the same star-average pill as the normal Browse view.
exports.smartSearch = (req, res) => {
    const userQuery = req.body.message || "";
    // Access user info from the request (sent from frontend)
    const { role, id: userId } = req.body.userContext || {}; 

    const sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email,
            COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.listing_id = l.id AND r.rating > 0), 0) AS avg_rating,
            (SELECT COUNT(*) FROM reviews r WHERE r.listing_id = l.id) AS review_count
        FROM listings l 
        LEFT JOIN users u ON l.user_id = u.id
    `;

    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const finalResults = runSmartSearch(userQuery, rows, role, userId);

        res.json({ success: true, results: finalResults });
    });
};
