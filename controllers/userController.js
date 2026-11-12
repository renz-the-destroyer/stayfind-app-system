const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { signUserToken } = require('../middleware/auth');
// Shared Taglish-aware Smart Search logic (see utils/smartSearchLogic.js).
const { runSmartSearch } = require('../utils/smartSearchLogic');
// In-memory cache for GET /api/view - see utils/listingsCache.js.
const listingsCache = require('../utils/listingsCache');

// 1. CREATE NEW USER (Used for Sign Up)
// - the password is stored as a bcrypt hash, never plain text
// - role is ALWAYS 'pending' here (the browser can't pick 'landlord')
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

// 2. SEARCH BY ID
// Never returns the password or the landlord verification documents.
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

// 3. UPDATE USER PROFILE
// - Contact must be an 11-digit PH mobile number starting with 09.
// - The 30-day personal-info lock uses its OWN column, info_changed_at.
//   Requires:  ALTER TABLE users ADD COLUMN info_changed_at DATETIME NULL;
// - First-time setup (dashboard) doesn't start the 30-day timer.
//
// Landlord approval gate: picking "Landlord" doesn't grant the role. It REQUIRES
// 4 verification images (landlord_documents, joined by '|||') PLUS
// landlord_doc_name, then sets landlord_status = 'pending' for admin review.
// Only the admin's approve action (adminController.js) sets role = 'landlord'.
exports.updateProfile = (req, res) => {
    const { full_name, address, contact, role, email, landlord_documents, landlord_doc_name } = req.body;

    if (role && !['tenant', 'landlord'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Invalid role.' });
    }

    if (contact && !/^09\d{9}$/.test(String(contact).trim())) {
        return res.status(400).json({ success: false, message: 'Contact must be an 11-digit mobile number starting with 09.' });
    }

    db.query('SELECT full_name, address, contact, role, landlord_status, landlord_documents, landlord_doc_name, info_changed_at FROM users WHERE id = ?', [req.userId], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = results[0];
        const lastChange = user.info_changed_at ? new Date(user.info_changed_at) : null;
        const now = new Date();
        const diffInDays = lastChange ? Math.floor((now - lastChange) / (1000 * 60 * 60 * 24)) : 40;

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
        const isLockedOut = !isFirstTimeSetup && isChangingPersonalInfo && lastChange !== null && diffInDays < 30;

        // A PLAIN personal-info edit is blocked while locked. A LANDLORD REQUEST is
        // never blocked: if locked, the retyped name/address/contact are ignored.
        if (isLockedOut && role !== 'landlord') {
            return res.status(403).json({ 
                success: false, 
                message: `Personal information can only be changed once every 30 days. Please wait ${30 - diffInDays} more days.` 
            });
        }

        const effectiveFullName = isLockedOut ? user.full_name : (full_name || user.full_name);
        const effectiveAddress = isLockedOut ? user.address : (address || user.address);
        const effectiveContact = isLockedOut ? user.contact : (contact || user.contact);

        let finalRole = role || user.role;
        let finalLandlordStatus = user.landlord_status || 'none';
        let finalLandlordDocs = user.landlord_documents; // unchanged by default
        let finalDocName = user.landlord_doc_name; // unchanged by default

        if (role === 'landlord') {
            if (user.landlord_status === 'approved') {
                finalRole = 'landlord';
            } else {
                if (!landlord_documents || landlord_documents.trim() === "") {
                    return res.status(400).json({
                        success: false,
                        message: 'Please upload all 4 required landlord verification items (Proof of Ownership, Local Permits, BIR Registration, and a Selfie with valid ID) before submitting your request.'
                    });
                }

                if (!landlord_doc_name || landlord_doc_name.trim() === "") {
                    return res.status(400).json({
                        success: false,
                        message: 'Please provide the name shown on your Proof of Ownership document.'
                    });
                }

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

        const timestampSQL = (isChangingPersonalInfo && !isLockedOut && !isFirstTimeSetup)
            ? 'info_changed_at = NOW()'
            : 'info_changed_at = info_changed_at';
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

            // The landlord's name/contact/status are shown on every one of
            // their cached listings, so drop the cache after a profile save.
            listingsCache.clear();

            let message;
            if (role === 'landlord' && finalLandlordStatus === 'pending') {
                message = isLockedOut
                    ? `Landlord request and documents submitted! (Note: your personal info edits were not applied. You can change those again in ${30 - diffInDays} more days.) Waiting for admin approval.`
                    : 'Landlord request and documents submitted! Waiting for admin approval.';
            } else {
                message = 'Profile updated successfully';
            }

            res.json({ 
                success: true, 
                message,
                role: finalRole,
                landlord_status: finalLandlordStatus
            });
        });
    });
};

// 4. GET ALL LISTINGS (Pagination + landlord scoping + visibility rules)
// Each row carries avg_rating and review_count via correlated subqueries.
// Responds with { listings, page, limit, total, totalPages, hasMore }.
// `all=true` skips pagination and returns every matching listing.
//
// NEW (Module 7) visibility rules:
//   - The public feed NEVER includes listings an admin hid, or listings of
//     suspended landlords.
//   - A landlord looking at their OWN listings (role=landlord&user_id=<them>,
//     confirmed against the login token) also gets their hidden ones, with
//     is_hidden / hidden_reason, so they can see what was hidden and why.
exports.getAllListings = (req, res) => {
    const { role, user_id, page, limit, all } = req.query;

    // The token (req.userId), not the query string, decides who is "the owner".
    const ownerView = role === 'landlord' && !!user_id && !!req.userId && String(req.userId) === String(user_id);

    // `owner` is part of the cache key so the owner's view is never served to anyone else.
    const cacheQuery = { ...req.query, owner: ownerView ? '1' : '' };
    const cached = listingsCache.get(cacheQuery);
    if (cached) return res.json(cached);

    const conditions = [];
    const whereParams = [];

    // Filter logic: if role is landlord, they ONLY see listings where they are the owner
    if (role === 'landlord' && user_id) {
        conditions.push('l.user_id = ?');
        whereParams.push(user_id);
    }
    if (!ownerView) {
        conditions.push('l.is_hidden = 0');
        conditions.push('u.is_suspended = 0');
    }
    const whereClause = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

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
            listingsCache.set(cacheQuery, payload);
            res.json(payload);
        });
        return;
    }

    const pageNum = Math.max(1, parseInt(page) || 1);
    const pageSize = Math.min(48, Math.max(1, parseInt(limit) || 12));
    const offset = (pageNum - 1) * pageSize;

    const countSql = `SELECT COUNT(*) AS total FROM listings l JOIN users u ON l.user_id = u.id${whereClause}`;
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
            listingsCache.set(cacheQuery, payload);
            res.json(payload);
        });
    });
};

// 5. ADD NEW LISTING
// The owner comes from the login token (req.userId), and only a user whose role
// is 'landlord' (set by admin approval) can post.
exports.addListing = (req, res) => {
    const { title, category, price, location, rooms, size, amenities, images, thumbnail, status } = req.body;
    const user_id = req.userId;
    const finalStatus = (status === 'occupied') ? 'occupied' : 'available';

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
            if (err) return res.status(500).json({ success: false, error: err.message, message: err.message });
            listingsCache.clear();
            res.json({ success: true, message: 'Listing Published Successfully', id: result.insertId });
        });
    });
};

// 6. ADD REVIEW (Supports Landlord Replies)
// The reviewer is the logged-in user (from the token), the display name comes
// from the DB, only the listing's own landlord can post a reply, and a landlord's
// own listing never receives a star rating from them.
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

// 7. GET REVIEWS (Ordered by Date)
exports.getReviews = (req, res) => {
    const { listing_id } = req.params;
    const sql = `SELECT * FROM reviews WHERE listing_id = ? ORDER BY created_at ASC`;
    
    db.query(sql, [listing_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 8. UPDATE LISTING (landlord edits their OWN listing)
// Photos use COALESCE so a save that didn't pick new photos leaves the existing
// ones untouched. A landlord can still edit a listing an admin hid; only an admin
// can unhide it.
exports.updateListing = (req, res) => {
    const { listingId, title, category, price, location, rooms, size, amenities, status, thumbnail, images } = req.body;
    const user_id = req.userId;
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
            listingsCache.clear();
            res.json({ success: true, message: 'Listing updated successfully!' });
        } else {
            res.status(403).json({ success: false, message: 'Unauthorized or listing not found' });
        }
    });
};

// 9. TOGGLE BOOKMARK
exports.toggleBookmark = (req, res) => {
    const { listingId, action } = req.body;
    const userId = req.userId;

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

// 10. GET BOOKMARKS
exports.getBookmarks = (req, res) => {
    const userId = req.params.id;
    if (String(userId) !== String(req.userId)) return res.status(403).json({ message: 'Forbidden' });
    const sql = "SELECT listing_id FROM bookmarks WHERE user_id = ?";
    db.query(sql, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 11. SMART SEARCH (Taglish-aware, with Role Security)
// NEW (Module 7): hidden listings and listings of suspended landlords are left
// out; a landlord still finds their own hidden ones (is_hidden is on the row).
exports.smartSearch = (req, res) => {
    const userQuery = req.body.message || "";
    const { role, id: userId } = req.body.userContext || {}; 

    const sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email,
            u.landlord_status AS landlord_status,
            COALESCE((SELECT AVG(r.rating) FROM reviews r WHERE r.listing_id = l.id AND r.rating > 0), 0) AS avg_rating,
            (SELECT COUNT(*) FROM reviews r WHERE r.listing_id = l.id) AS review_count
        FROM listings l 
        LEFT JOIN users u ON l.user_id = u.id
        WHERE COALESCE(u.is_suspended, 0) = 0 AND (l.is_hidden = 0 OR l.user_id = ?)
    `;

    db.query(sql, [req.userId || 0], (err, rows) => {
        if (err) return res.status(500).json({ success: false, error: err.message });

        const finalResults = runSmartSearch(userQuery, rows, role, userId);

        res.json({ success: true, results: finalResults });
    });
};

// ============================================================================
// 12. MESSAGING SYSTEM - tenant <-> landlord direct messages
// ============================================================================
// Requires two tables:
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

// 12a. START (OR RESUME) A CONVERSATION
// The tenant is the logged-in user (token) and the landlord is looked up from
// the listing itself, so ids sent in the body are ignored.
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

// 12b. LIST A USER'S CONVERSATIONS (their Messages inbox) - you can only list your own.
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

// 12c. GET MESSAGES IN A CONVERSATION
// Only the two people in the conversation can read it, and "mark as read"
// applies to the logged-in user.
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

// 12d. SEND A MESSAGE - the sender is the logged-in user, and must be part of the conversation.
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

// ============================================================================
// 13. DELETE LISTING (landlord deletes their OWN listing)
// ============================================================================
// Deletes a listing AND everything that points at it (reviews, bookmarks, chat
// conversations + their messages), all-or-nothing in ONE transaction, and only
// if this landlord owns it. (Admins can no longer delete listings - Module 7.)
function deleteListingWithDependents(listingId, ownerId, done) {
    db.getConnection((connErr, conn) => {
        if (connErr) return done(connErr);

        const fail = (err) => conn.rollback(() => { conn.release(); done(err); });

        conn.beginTransaction((txErr) => {
            if (txErr) { conn.release(); return done(txErr); }

            conn.query('SELECT id FROM listings WHERE id = ? AND user_id = ?', [listingId, ownerId], (checkErr, rows) => {
                if (checkErr) return fail(checkErr);
                if (rows.length === 0) {
                    // Not found, or not this landlord's listing: change nothing.
                    return conn.rollback(() => { conn.release(); done(null, 0); });
                }

                // Order matters: children first, the listing itself last.
                const steps = [
                    ['DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE listing_id = ?)', [listingId]],
                    ['DELETE FROM conversations WHERE listing_id = ?', [listingId]],
                    // Landlord replies point at the review they answer, so remove replies first.
                    ['DELETE FROM reviews WHERE listing_id = ? AND parent_review_id IS NOT NULL', [listingId]],
                    ['DELETE FROM reviews WHERE listing_id = ?', [listingId]],
                    ['DELETE FROM bookmarks WHERE listing_id = ?', [listingId]],
                    ['DELETE FROM listings WHERE id = ?', [listingId]]
                ];

                const run = (i) => {
                    if (i >= steps.length) {
                        return conn.commit((commitErr) => {
                            if (commitErr) return fail(commitErr);
                            conn.release();
                            done(null, 1);
                        });
                    }
                    conn.query(steps[i][0], steps[i][1], (stepErr) => {
                        if (stepErr) return fail(stepErr);
                        run(i + 1);
                    });
                };
                run(0);
            });
        });
    });
}

exports.deleteListing = (req, res) => {
    const listingId = req.params.id;
    const user_id = req.userId; // from the login token

    deleteListingWithDependents(listingId, user_id, (err, affectedRows) => {
        if (err) {
            console.error('Delete listing failed:', err.message);
            return res.status(500).json({ success: false, message: 'Could not delete the listing. Please try again.', error: err.message });
        }
        if (!affectedRows) {
            return res.status(403).json({ success: false, message: 'Unauthorized or Listing not found' });
        }
        listingsCache.clear();
        res.json({ success: true, message: 'Listing deleted successfully' });
    });
};
