const db = require('../config/db');
// NEW: password hashing for sign up (see createUser below)
const bcrypt = require('bcryptjs');
const { signUserToken } = require('../middleware/auth');
// NEW: Shared Taglish-aware Smart Search logic (see utils/smartSearchLogic.js).
// Used here AND in server.js so both stay in sync.
const { runSmartSearch } = require('../utils/smartSearchLogic');
// NEW: in-memory cache for GET /api/view - see utils/listingsCache.js for
// the full explanation of the TTL + clear-on-write strategy.
const listingsCache = require('../utils/listingsCache');

// 1. GET ALL USERS
// UPDATED: no longer reachable - the GET /users route was removed because it
// sent every user's password to the browser (login is now POST /api/login in
// authController.js). Kept here, but it strips sensitive columns just in case
// it ever gets wired up again.
exports.getAllUsers = (req, res) => {
    const sql = "SELECT * FROM users";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const safeRows = rows.map(({ password, landlord_documents, ...rest }) => rest);
        res.json(safeRows);
    });
};

// 2. CREATE NEW USER (Used for Sign Up)
// UPDATED:
// - the password is stored as a bcrypt hash, never plain text
// - role is ALWAYS 'pending' here. The old version trusted whatever role the
//   browser sent, so anyone could register as 'landlord' and skip the admin
//   approval flow.
// - duplicate emails are rejected
// - returns a login token so the new user can go straight to the dashboard
exports.createUser = (req, res) => {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password || String(password).length < 8) {
        return res.status(400).json({ success: false, message: 'Name, email, and a password of at least 8 characters are required.' });
    }

    const cleanEmail = String(email).trim().toLowerCase();

    db.query('SELECT id FROM users WHERE LOWER(email) = ? LIMIT 1', [cleanEmail], async (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        if (rows.length > 0) {
            return res.status(409).json({ success: false, message: 'An account with that email already exists.' });
        }

        try {
            const hash = await bcrypt.hash(String(password), 10);
            const sql = `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, 'pending')`;
            db.query(sql, [String(full_name).trim(), cleanEmail, hash], (insErr, result) => {
                if (insErr) {
                    console.error("SQL Error:", insErr.message);
                    return res.status(500).json({ success: false, message: 'Could not create the account.' });
                }
                let token;
                try {
                    token = signUserToken({ id: result.insertId });
                } catch (tokenErr) {
                    return res.status(500).json({ success: false, message: 'Account created, but sign-in is unavailable. Please log in.' });
                }
                res.json({ success: true, message: 'Account Created Successfully', id: result.insertId, token });
            });
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not create the account.' });
        }
    });
};

// 3. UPDATE USER
// (No longer reachable - the PUT /update route was removed because it had no
// auth. Kept here for now; safe to delete later.)
exports.updateUser = (req, res) => {
    const { id, full_name, email, role } = req.body;
    const sql = `UPDATE users SET full_name = ?, email = ?, role = ? WHERE id = ?`;
    db.query(sql, [full_name, email, role, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            listingsCache.clear(); // NEW: landlord_name shown on cached listings may have just changed
            res.json({ success: true, message: 'User Updated Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 4. DELETE USER
// (No longer reachable - the DELETE /delete route was removed because it had
// no auth. Kept here for now; safe to delete later.)
exports.deleteUser = (req, res) => {
    const { id } = req.body;
    db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            listingsCache.clear(); // NEW: this user's listings may no longer appear in /api/view
            res.json({ success: true, message: 'User Deleted Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 5. SEARCH BY ID
// UPDATED: never returns the password or the landlord verification documents.
exports.getUserById = (req, res) => {
    const id = req.params.id;
    // Only your own profile - nobody can read another user's details by id.
    if (String(id) !== String(req.userId)) return res.status(403).json({ message: 'Forbidden' });
    db.query('SELECT * FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
        const { password, landlord_documents, ...safeUser } = rows[0];
        res.json(safeUser);
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

    // Only these two roles can be requested here. 'landlord' still goes through
    // the document + admin approval gate below.
    if (role && !['tenant', 'landlord'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Invalid role.' });
    }

    db.query('SELECT full_name, address, contact, role, landlord_status, landlord_documents, landlord_doc_name, updated_at FROM users WHERE id = ?', [req.userId], (err, results) => {
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
        const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ?, landlord_status = ?, landlord_documents = ?, landlord_doc_name = ?, ${timestampSQL} WHERE id = ?`;
        
        db.query(sql, [
            effectiveFullName,
            effectiveAddress,
            effectiveContact,
            finalRole,
            finalLandlordStatus,
            finalLandlordDocs,
            finalDocName,
            req.userId
        ], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });

            // NEW: the landlord's name/contact/status are shown on every one
            // of their cached listings, so drop the cache after a profile save.
            listingsCache.clear();

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

// 7. GET ALL LISTINGS (Strict Landlord Filtering + Pagination)
// UPDATED: each row still carries avg_rating and review_count via the same
// two correlated subqueries as before:
//   - avg_rating: the mean of `rating` across rows that actually have a star
//     rating (rating > 0), so text-only comments and landlord replies
//     (rating = 0) never drag the average down. COALESCE'd to 0 for
//     listings with no ratings yet.
//   - review_count: the total number of rows in `reviews` for this listing
//     (matches what the details modal already shows via revCount, which
//     uses reviews.length from GET /get-reviews/:listing_id - comments and
//     replies both count there too).
//
// NEW: this endpoint used to return every matching listing - with every
// embedded base64 photo - in a single response, which gets slow and heavy
// as the listings table grows. It now paginates via `page`/`limit` query
// params (defaults: page=1, limit=12, capped at 48/page) and always
// responds with { listings, page, limit, total, totalPages, hasMore }
// instead of a bare array, so home.js can show a "Load More" control and
// know when it's reached the end.
//
// Pass `all=true` to skip pagination and get every matching listing back in
// one response (still shaped the same way, with totalPages: 1). home.js
// uses this for the Saved view and anywhere else that needs the complete
// list in memory to filter correctly - paginating those would mean a saved
// listing on page 2 silently not showing up until "Load More" was clicked.
//
// NEW (verified badge): rows now also carry u.landlord_status. home.js's
// buildVerifiedBadgeHTML() reads item.landlord_status to decide whether to
// show the "Verified" badge, but this query never selected that column, so
// the badge could never appear.
exports.getAllListings = (req, res) => {
    const { role, user_id, page, limit, all } = req.query;

    // NEW: serve straight from the in-memory cache when there's a fresh
    // entry for this exact combination of role/user_id/page/limit/all - no
    // DB round trip at all for a cache hit.
    const cached = listingsCache.get(req.query);
    if (cached) return res.json(cached);

    let whereClause = '';
    let whereParams = [];

    // Filter logic: If role is landlord, they ONLY see listings where they are the owner
    if (role === 'landlord' && user_id) {
        whereClause = ' WHERE l.user_id = ?';
        whereParams.push(user_id);
    }

    const baseSelect = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email,
            u.landlord_status AS landlord_status,
            COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.listing_id = l.id AND r.rating > 0), 0) AS avg_rating,
            (SELECT COUNT(*) FROM reviews r WHERE r.listing_id = l.id) AS review_count
        FROM listings l 
        JOIN users u ON l.user_id = u.id${whereClause}
        ORDER BY l.created_at DESC`;

    if (all === 'true') {
        db.query(baseSelect, whereParams, (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const payload = { listings: rows, page: 1, limit: rows.length, total: rows.length, totalPages: 1, hasMore: false };
            listingsCache.set(req.query, payload); // NEW
            res.json(payload);
        });
        return;
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(48, Math.max(1, parseInt(limit) || 12));
    const offset = (pageNum - 1) * pageSize;

    const countSql = `SELECT COUNT(*) AS total FROM listings l${whereClause}`;
    db.query(countSql, whereParams, (countErr, countRows) => {
        if (countErr) return res.status(500).json({ error: countErr.message });
        const total = countRows[0].total;

        const sql = `${baseSelect} LIMIT ? OFFSET ?`;
        db.query(sql, [...whereParams, pageSize, offset], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            const payload = {
                listings: rows,
                page: pageNum,
                limit: pageSize,
                total,
                totalPages: Math.max(1, Math.ceil(total / pageSize)),
                hasMore: offset + rows.length < total
            };
            listingsCache.set(req.query, payload); // NEW
            res.json(payload);
        });
    });
};

// 8. ADD NEW LISTING
// UPDATED: the owner comes from the login token (req.userId), not from the
// request body, and only a user whose role is 'landlord' (set by admin
// approval) can post. Also accepts/saves `status` ('available' | 'occupied').
exports.addListing = (req, res) => {
    const { title, category, price, location, rooms, size, amenities, images, thumbnail, status } = req.body;
    const user_id = req.userId;
    const finalStatus = (status === 'occupied') ? 'occupied' : 'available';

    // Friendly guard for oversized photo payloads (see the Cloudinary note in home.js).
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

    db.query('SELECT role FROM users WHERE id = ?', [user_id], (roleErr, roleRows) => {
        if (roleErr) return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        if (roleRows.length === 0 || roleRows[0].role !== 'landlord') {
            return res.status(403).json({ success: false, message: 'Only approved landlords can post listings.' });
        }

        const sql = `INSERT INTO listings (user_id, title, category, price, location, rooms, size, amenities, images, thumbnail, status) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [user_id, title, category, price, location, rooms, size, amenities, images, thumbnail, finalStatus];

        db.query(sql, values, (err, result) => {
            // `message` is included (besides `error`) because home.js shows errResult.message.
            if (err) return res.status(500).json({ success: false, error: err.message, message: err.message });
            listingsCache.clear(); // a new listing exists now - don't let a cached /api/view hide it
            res.json({ success: true, message: 'Listing Published Successfully', id: result.insertId });
        });
    });
};

// 9. ADD REVIEW (Supports Landlord Replies)
// UPDATED: the reviewer is the logged-in user (from the token), the display
// name comes from the DB (can't be faked), only the listing's own landlord can
// post a reply, and a landlord's own listing never receives a star rating from them.
// Requires `parent_review_id INT NULL` on the reviews table (see earlier migration).
exports.addReview = (req, res) => {
    const { listing_id, comment, rating, is_reply, parent_review_id } = req.body;
    const user_id = req.userId;

    if (!listing_id) return res.status(400).json({ success: false, message: 'listing_id is required.' });

    const lookupSql = `SELECT u.full_name, l.user_id AS owner_id
                       FROM users u JOIN listings l ON l.id = ?
                       WHERE u.id = ?`;
    db.query(lookupSql, [listing_id, user_id], (lookupErr, rows) => {
        if (lookupErr) return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'Listing not found.' });

        const { full_name, owner_id } = rows[0];
        const isOwner = Number(owner_id) === Number(user_id);

        if (is_reply && !isOwner) {
            return res.status(403).json({ success: false, message: 'Only the landlord of this listing can reply.' });
        }

        // rating is 0 for a landlord reply or the landlord's own comment
        const cleanRating = Math.min(5, Math.max(0, parseInt(rating) || 0));
        const finalRating = (is_reply || isOwner) ? 0 : cleanRating;
        const finalReplyStatus = is_reply ? 1 : 0;
        const finalParentId = is_reply && parent_review_id ? parent_review_id : null;

        const sql = `INSERT INTO reviews (listing_id, user_id, user_name, comment, rating, is_reply, parent_review_id) VALUES (?, ?, ?, ?, ?, ?, ?)`;
        db.query(sql, [listing_id, user_id, full_name || 'User', comment, finalRating, finalReplyStatus, finalParentId], (err) => {
            if (err) return res.status(500).json({ error: err.message });
            listingsCache.clear(); // changes the listing's avg_rating/review_count
            res.json({ success: true, message: finalReplyStatus ? 'Reply submitted!' : 'Review submitted!' });
        });
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
    const user_id = req.userId; // from the login token

    const sql = "DELETE FROM listings WHERE id = ? AND user_id = ?";
    
    db.query(sql, [listingId, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            listingsCache.clear(); // NEW: this listing no longer exists - don't let a cached /api/view keep showing it
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
    const { listingId, title, category, price, location, rooms, size, amenities, status, thumbnail, images } = req.body;
    const user_id = req.userId; // from the login token
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
            listingsCache.clear(); // NEW: price/photos/status etc. just changed - don't serve a stale cached version
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
    const { listingId, action } = req.body;
    const userId = req.userId; // from the login token

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
    if (String(userId) !== String(req.userId)) return res.status(403).json({ message: 'Forbidden' });
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
// NEW (verified badge): also selects u.landlord_status so Smart Search
// result cards can show the Verified badge too.
exports.smartSearch = (req, res) => {
    const userQuery = req.body.message || "";
    // Access user info from the request (sent from frontend)
    const { role, id: userId } = req.body.userContext || {}; 

    const sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email,
            u.landlord_status AS landlord_status,
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

// ============================================================================
// 16. MESSAGING SYSTEM (NEW) — tenant <-> landlord direct messages
// ============================================================================
// Requires two new tables. Run once on your MySQL database (same pattern as
// the earlier LONGTEXT/parent_review_id migrations):
//
//   CREATE TABLE conversations (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     listing_id INT NOT NULL,
//     tenant_id INT NOT NULL,
//     landlord_id INT NOT NULL,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     last_message_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     UNIQUE KEY unique_thread (listing_id, tenant_id, landlord_id)
//   );
//
//   CREATE TABLE messages (
//     id INT AUTO_INCREMENT PRIMARY KEY,
//     conversation_id INT NOT NULL,
//     sender_id INT NOT NULL,
//     message TEXT NOT NULL,
//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     is_read TINYINT(1) DEFAULT 0
//   );
//
// A "conversation" is uniquely identified by (listing_id, tenant_id,
// landlord_id) - the UNIQUE KEY means the same tenant messaging the same
// landlord about the same listing always lands in the same thread, even if
// they click "Message Landlord" from that listing more than once.

// 16a. START (OR RESUME) A CONVERSATION
// UPDATED: the tenant is the logged-in user (token) and the landlord is looked
// up from the listing itself, so ids sent in the body are ignored.
exports.startConversation = (req, res) => {
    const { listing_id } = req.body;
    const tenant_id = req.userId;

    if (!listing_id) {
        return res.status(400).json({ success: false, message: 'listing_id is required.' });
    }

    db.query('SELECT user_id FROM listings WHERE id = ?', [listing_id], (lErr, lRows) => {
        if (lErr) return res.status(500).json({ error: lErr.message });
        if (lRows.length === 0) return res.status(404).json({ success: false, message: 'Listing not found.' });

        const landlord_id = lRows[0].user_id;
        if (String(tenant_id) === String(landlord_id)) {
            return res.status(400).json({ success: false, message: "You can't message yourself about your own listing." });
        }

        const findSql = `SELECT id FROM conversations WHERE listing_id = ? AND tenant_id = ? AND landlord_id = ?`;
        db.query(findSql, [listing_id, tenant_id, landlord_id], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            if (rows.length > 0) {
                return res.json({ success: true, conversation_id: rows[0].id });
            }

            const insertSql = `INSERT INTO conversations (listing_id, tenant_id, landlord_id) VALUES (?, ?, ?)`;
            db.query(insertSql, [listing_id, tenant_id, landlord_id], (insertErr, result) => {
                // Two requests racing (double click) can both try to create the thread.
                if (insertErr && insertErr.code === 'ER_DUP_ENTRY') {
                    return db.query(findSql, [listing_id, tenant_id, landlord_id], (raceErr, raceRows) => {
                        if (raceErr) return res.status(500).json({ error: raceErr.message });
                        return res.json({ success: true, conversation_id: raceRows[0].id });
                    });
                }
                if (insertErr) return res.status(500).json({ error: insertErr.message });
                res.json({ success: true, conversation_id: result.insertId });
            });
        });
    });
};

// 16b. LIST A USER'S CONVERSATIONS (their Messages inbox)
// UPDATED: you can only list your own conversations.
exports.getConversations = (req, res) => {
    const userId = req.params.userId;
    if (String(userId) !== String(req.userId)) return res.status(403).json({ message: 'Forbidden' });

    const sql = `
        SELECT c.*,
            l.title AS listing_title,
            l.thumbnail AS listing_thumbnail,
            CASE WHEN c.tenant_id = ? THEN c.landlord_id ELSE c.tenant_id END AS other_user_id,
            CASE WHEN c.tenant_id = ? THEN landlord.full_name ELSE tenant.full_name END AS other_user_name,
            (SELECT m.message FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.sender_id != ? AND m.is_read = 0) AS unread_count
        FROM conversations c
        JOIN listings l ON c.listing_id = l.id
        JOIN users tenant ON c.tenant_id = tenant.id
        JOIN users landlord ON c.landlord_id = landlord.id
        WHERE c.tenant_id = ? OR c.landlord_id = ?
        ORDER BY c.last_message_at DESC
    `;

    db.query(sql, [userId, userId, userId, userId, userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// Shared check: is the logged-in user one of the two people in this conversation?
function checkConversationMember(conversationId, userId, callback) {
    db.query('SELECT tenant_id, landlord_id FROM conversations WHERE id = ?', [conversationId], (err, rows) => {
        if (err) return callback(err);
        if (rows.length === 0) return callback(null, 'not_found');
        const c = rows[0];
        const isMember = String(c.tenant_id) === String(userId) || String(c.landlord_id) === String(userId);
        callback(null, isMember ? 'ok' : 'forbidden');
    });
}

// 16c. GET MESSAGES IN A CONVERSATION
// UPDATED: only the two people in the conversation can read it, and "mark as
// read" applies to the logged-in user (the ?user_id= query param is ignored).
exports.getMessages = (req, res) => {
    const conversationId = req.params.conversationId;
    const viewerId = req.userId;

    checkConversationMember(conversationId, viewerId, (memberErr, status) => {
        if (memberErr) return res.status(500).json({ error: memberErr.message });
        if (status === 'not_found') return res.status(404).json({ message: 'Conversation not found' });
        if (status === 'forbidden') return res.status(403).json({ message: 'Forbidden' });

        db.query(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`, [conversationId], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });

            const markReadSql = `UPDATE messages SET is_read = 1 WHERE conversation_id = ? AND sender_id != ? AND is_read = 0`;
            db.query(markReadSql, [conversationId, viewerId], () => { /* best-effort - the list already went out */ });

            res.json(rows);
        });
    });
};

// 16d. SEND A MESSAGE
// UPDATED: the sender is the logged-in user, and they must be part of the conversation.
exports.sendMessage = (req, res) => {
    const { conversation_id, message } = req.body;
    const sender_id = req.userId;
    const trimmed = (message || '').trim();

    if (!conversation_id || !trimmed) {
        return res.status(400).json({ success: false, message: 'conversation_id and a non-empty message are required.' });
    }

    checkConversationMember(conversation_id, sender_id, (memberErr, status) => {
        if (memberErr) return res.status(500).json({ error: memberErr.message });
        if (status === 'not_found') return res.status(404).json({ success: false, message: 'Conversation not found' });
        if (status === 'forbidden') return res.status(403).json({ success: false, message: 'Forbidden' });

        const insertSql = `INSERT INTO messages (conversation_id, sender_id, message) VALUES (?, ?, ?)`;
        db.query(insertSql, [conversation_id, sender_id, trimmed], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });

            db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = ?`, [conversation_id], () => { /* best-effort */ });

            res.json({
                success: true,
                message_id: result.insertId,
                created_at: new Date().toISOString()
            });
        });
    });
};
