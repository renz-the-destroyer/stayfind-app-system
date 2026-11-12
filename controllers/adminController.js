const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { signAdminToken, requireAdmin, markSuspended, markActive } = require('../middleware/auth');
// Same in-memory /api/view cache used by userController.js - anything an admin
// does that changes what the public sees must clear it.
const listingsCache = require('../utils/listingsCache');

const BCRYPT_ROUNDS = 10;
const isBcryptHash = (str) => typeof str === 'string' && /^\$2[aby]\$\d{2}\$/.test(str);

// ============================================================================
//  LOGIN / IDENTITY
// ============================================================================

// Checks the `admins` DB table. Passwords are bcrypt-hashed. Any admin still on
// a plain-text password is accepted once and upgraded to a hash right then.
exports.adminLogin = (req, res) => {
    const email = (req.body.email || '').toString().trim();
    const password = (req.body.password || '').toString();

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    db.query('SELECT id, full_name, email, password FROM admins WHERE email = ? LIMIT 1', [email], async (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error. Please try again.' });

        const invalid = () => res.status(401).json({ success: false, message: 'Invalid admin credentials' });
        const admin = rows[0];
        if (!admin) return invalid();

        let ok = false;
        try {
            if (isBcryptHash(admin.password)) {
                ok = await bcrypt.compare(password, admin.password);
            } else if (String(admin.password || '') === password) {
                ok = true;
                const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
                db.query('UPDATE admins SET password = ? WHERE id = ?', [newHash, admin.id], () => {});
            }
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }

        if (!ok) return invalid();

        // The "adminKey" the panel sends back in the x-admin-key header is a SIGNED
        // token that expires after 2 hours.
        let adminToken;
        try {
            adminToken = signAdminToken(admin);
        } catch (e) {
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }

        return res.json({
            success: true,
            adminKey: adminToken,
            admin: { id: admin.id, full_name: admin.full_name, email: admin.email }
        });
    });
};

// Guards every route below it in adminRoutes.js.
exports.verifyAdminKey = requireAdmin;

// Name and email of the admin the token belongs to, read from the database.
// If that admin account no longer exists, answer 401 so the panel signs out.
exports.getMe = (req, res) => {
    db.query('SELECT id, full_name, email FROM admins WHERE id = ? LIMIT 1', [req.adminId], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Unauthorized: this admin account no longer exists.' });
        }
        res.json({ success: true, admin: rows[0] });
    });
};

// ============================================================================
//  DASHBOARD
// ============================================================================
exports.getStats = (req, res) => {
    const sql = `
        SELECT
            (SELECT COUNT(*) FROM users) AS totalUsers,
            (SELECT COUNT(*) FROM users WHERE role = 'landlord') AS totalLandlords,
            (SELECT COUNT(*) FROM users WHERE role = 'tenant') AS totalTenants,
            (SELECT COUNT(*) FROM users WHERE landlord_status = 'pending') AS pendingRequests,
            (SELECT COUNT(*) FROM listings) AS totalListings
    `;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows[0]);
    });
};

exports.getOverview = async (req, res) => {
    const q = (sql) => new Promise((resolve, reject) => {
        db.query(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
    });

    try {
        const [byCategory, byStatus, byLandlordStatus, perMonth] = await Promise.all([
            q(`SELECT category, COUNT(*) AS n FROM listings GROUP BY category ORDER BY n DESC`),
            q(`SELECT COALESCE(status,'available') AS status, COUNT(*) AS n
               FROM listings GROUP BY COALESCE(status,'available')`),
            q(`SELECT COALESCE(landlord_status,'none') AS status, COUNT(*) AS n
               FROM users GROUP BY COALESCE(landlord_status,'none')`),
            q(`SELECT DATE_FORMAT(created_at,'%Y-%m') AS ym, COUNT(*) AS n
               FROM listings
               WHERE created_at >= DATE_FORMAT(DATE_SUB(CURDATE(), INTERVAL 5 MONTH), '%Y-%m-01')
               GROUP BY DATE_FORMAT(created_at,'%Y-%m')
               ORDER BY ym`)
        ]);
        res.json({ byCategory, byStatus, byLandlordStatus, perMonth });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// ============================================================================
//  USERS  (view, edit, approve/reject landlords, suspend / unsuspend)
//  Admins can NOT delete users any more (Module 7): deleting one also wiped all
//  of that landlord's listings. Suspending is reversible and keeps the data.
// ============================================================================
exports.getAllUsersAdmin = (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const sql = `SELECT id, full_name, email, role, landlord_status, address, contact, is_suspended, suspended_reason
                 FROM users WHERE full_name LIKE ? OR email LIKE ? ORDER BY id DESC`;
    db.query(sql, [search, search], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

const VALID_ROLES = ['tenant', 'landlord', 'pending'];
const VALID_LANDLORD_STATUSES = ['none', 'pending', 'approved', 'rejected'];

// Bad values are rejected BEFORE anything reaches the database.
exports.updateUserAdmin = (req, res) => {
    const { id } = req.params;
    const { full_name, email, role, address, contact, landlord_status } = req.body || {};

    if (!full_name || !String(full_name).trim()) {
        return res.status(400).json({ success: false, message: 'Full name is required.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim())) {
        return res.status(400).json({ success: false, message: 'Please enter a valid email address.' });
    }
    if (!VALID_ROLES.includes(role)) {
        return res.status(400).json({ success: false, message: 'Invalid role.' });
    }
    if (!VALID_LANDLORD_STATUSES.includes(landlord_status)) {
        return res.status(400).json({ success: false, message: 'Invalid landlord status.' });
    }

    const sql = `UPDATE users SET full_name=?, email=?, role=?, address=?, contact=?, landlord_status=? WHERE id=?`;
    db.query(sql, [full_name, email, role, address, contact, landlord_status, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear(); // landlord name/status shown on cached listings may have changed
        res.json({ success: true, message: 'User updated successfully' });
    });
};

// Moderation reasons: required, no angle brackets, max 500 characters.
function cleanReason(raw) {
    return String(raw || '').replace(/[<>]/g, '').trim().slice(0, 500);
}

// POST /api/admin/users/:id/suspend   { reason }
exports.suspendUser = (req, res) => {
    const { id } = req.params;
    const reason = cleanReason(req.body && req.body.reason);
    if (reason.length < 3) {
        return res.status(400).json({ success: false, message: 'Please give a reason for the suspension.' });
    }

    const sql = `UPDATE users SET is_suspended = 1, suspended_reason = ?, suspended_at = NOW() WHERE id = ?`;
    db.query(sql, [reason, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        markSuspended(id);     // takes effect on their very next request
        listingsCache.clear(); // their listings leave the public feed
        res.json({ success: true, message: 'User suspended' });
    });
};

// POST /api/admin/users/:id/unsuspend
exports.unsuspendUser = (req, res) => {
    const { id } = req.params;
    const sql = `UPDATE users SET is_suspended = 0, suspended_reason = NULL, suspended_at = NULL WHERE id = ?`;
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        markActive(id);
        listingsCache.clear();
        res.json({ success: true, message: 'User unsuspended' });
    });
};

// ============================================================================
//  LANDLORD APPROVAL WORKFLOW
// ============================================================================
// Light list: NO huge base64 documents. They are fetched one applicant at a
// time by getLandlordRequestDocs, only when an admin clicks "View Docs".
exports.getLandlordRequests = (req, res) => {
    const sql = `
        SELECT id, full_name, email, contact, address, landlord_doc_name,
               (landlord_documents IS NOT NULL AND landlord_documents <> '') AS has_documents
        FROM users
        WHERE landlord_status = 'pending'
        ORDER BY id DESC
    `;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

exports.getLandlordRequestDocs = (req, res) => {
    const { id } = req.params;
    db.query('SELECT landlord_documents FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ documents: rows[0].landlord_documents || '' });
    });
};

// This is the ONLY place a user's role actually becomes 'landlord'.
exports.approveLandlord = (req, res) => {
    const { id } = req.params;
    const sql = `UPDATE users SET role = 'landlord', landlord_status = 'approved', landlord_rejection_reason = NULL WHERE id = ?`;
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear(); // landlord_status (Verified badge) is shown on cached listings
        res.json({ success: true, message: 'Landlord request approved' });
    });
};

// Accepts whatever string admin.js sends as `reason` (template picker or custom text).
exports.rejectLandlord = (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const finalReason = (reason && reason.trim() !== "") ? reason.trim() : "Your submitted documents did not meet our requirements.";

    const sql = `UPDATE users SET landlord_status = 'rejected', landlord_rejection_reason = ? WHERE id = ?`;
    db.query(sql, [finalReason, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear();
        res.json({ success: true, message: 'Landlord request rejected' });
    });
};

// ============================================================================
//  LISTINGS  (view, hide / unhide)
//  Admins can NOT delete or edit listings any more (Module 7). They moderate:
//  a hidden listing disappears from the public feed, the landlord still sees it
//  together with the reason, and an admin can unhide it at any time.
// ============================================================================
// Light list: only the columns the panel needs (no photo blobs). `thumbnail` is
// only sent when it's a short URL, so old base64 thumbnails never bloat it.
exports.getAllListingsAdmin = (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const sql = `
        SELECT l.id, l.user_id, l.title, l.category, l.price, l.location, l.rooms, l.size,
               l.amenities, l.status, l.created_at,
               l.is_hidden, l.hidden_reason, l.hidden_at,
               CASE WHEN LENGTH(l.thumbnail) < 1000 THEN l.thumbnail ELSE NULL END AS thumbnail,
               u.full_name AS landlord_name, u.email AS landlord_email
        FROM listings l
        JOIN users u ON l.user_id = u.id
        WHERE l.title LIKE ? OR l.location LIKE ?
        ORDER BY l.created_at DESC
    `;
    db.query(sql, [search, search], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// POST /api/admin/listings/:id/hide   { reason }
exports.hideListing = (req, res) => {
    const { id } = req.params;
    const reason = cleanReason(req.body && req.body.reason);
    if (reason.length < 3) {
        return res.status(400).json({ success: false, message: 'Please give a reason for hiding this listing.' });
    }

    const sql = `UPDATE listings SET is_hidden = 1, hidden_reason = ?, hidden_at = NOW(), hidden_by = ? WHERE id = ?`;
    db.query(sql, [reason, req.adminId, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Listing not found' });
        listingsCache.clear();
        res.json({ success: true, message: 'Listing hidden' });
    });
};

// POST /api/admin/listings/:id/unhide
exports.unhideListing = (req, res) => {
    const { id } = req.params;
    const sql = `UPDATE listings SET is_hidden = 0, hidden_reason = NULL, hidden_at = NULL, hidden_by = NULL WHERE id = ?`;
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Listing not found' });
        listingsCache.clear();
        res.json({ success: true, message: 'Listing is visible again' });
    });
};

// ============================================================================
//  REVIEWS (moderation)
// ============================================================================
exports.getAllReviewsAdmin = (req, res) => {
    const sql = `SELECT r.*, l.title AS listing_title FROM reviews r LEFT JOIN listings l ON r.listing_id = l.id ORDER BY r.created_at DESC`;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

exports.deleteReviewAdmin = (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM reviews WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Review not found' });
        listingsCache.clear(); // a deleted review can change the listing's avg_rating/review_count
        res.json({ success: true, message: 'Review deleted successfully' });
    });
};

// ============================================================================
//  ADMIN ACCOUNT MANAGEMENT (the "Settings" panel)
// ============================================================================
// Never sends passwords.
exports.getAllAdmins = (req, res) => {
    const sql = `SELECT id, full_name, email, created_at FROM admins ORDER BY id ASC`;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

exports.createAdmin = async (req, res) => {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Full name, email, and password are all required.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    try {
        const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        const sql = `INSERT INTO admins (full_name, email, password) VALUES (?, ?, ?)`;
        db.query(sql, [full_name, email, hash], (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ success: false, message: 'An admin with that email already exists.' });
                }
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, message: 'Admin account created successfully', id: result.insertId });
        });
    } catch (e) {
        res.status(500).json({ success: false, message: 'Could not create the admin account.' });
    }
};

// Password is optional on edit - leaving it blank keeps the existing password.
exports.updateAdmin = async (req, res) => {
    const { id } = req.params;
    const { full_name, email, password } = req.body;

    if (!full_name || !email) {
        return res.status(400).json({ success: false, message: 'Full name and email are required.' });
    }

    const finishUpdate = (sql, params) => {
        db.query(sql, params, (err, result) => {
            if (err) {
                if (err.code === 'ER_DUP_ENTRY') {
                    return res.status(409).json({ success: false, message: 'Another admin already uses that email.' });
                }
                return res.status(500).json({ error: err.message });
            }
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Admin not found' });
            res.json({ success: true, message: 'Admin account updated successfully' });
        });
    };

    if (password && password.trim() !== "") {
        if (password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
        }
        try {
            const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
            finishUpdate(`UPDATE admins SET full_name=?, email=?, password=? WHERE id=?`, [full_name, email, hash, id]);
        } catch (e) {
            res.status(500).json({ success: false, message: 'Could not update the admin account.' });
        }
    } else {
        finishUpdate(`UPDATE admins SET full_name=?, email=? WHERE id=?`, [full_name, email, id]);
    }
};

// Guards: an admin can't delete their OWN account, and the last remaining admin
// can never be deleted (or the panel becomes permanently inaccessible).
exports.deleteAdmin = (req, res) => {
    const { id } = req.params;

    if (String(id) === String(req.adminId)) {
        return res.status(400).json({ success: false, message: "You can't delete your own admin account while logged in." });
    }

    db.query('SELECT COUNT(*) AS total FROM admins', (err, countRows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (countRows[0].total <= 1) {
            return res.status(400).json({ success: false, message: 'Cannot delete the last remaining admin account.' });
        }

        db.query('DELETE FROM admins WHERE id = ?', [id], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (result.affectedRows === 0) return res.status(404).json({ message: 'Admin not found' });
            res.json({ success: true, message: 'Admin account deleted successfully' });
        });
    });
};

// ============================================================================
//  ACTIVITY LOG with filters and "load more"  (GET /api/admin/audit-log)
// ============================================================================
// Query string (all optional):
//   limit      rows per page (default 25, max 100)
//   admin_id   only this admin's actions
//   action     one of the keys in AUDIT_ACTIONS below
//   from, to   dates as YYYY-MM-DD (inclusive), in the ADMIN'S timezone
//   tz         the admin's timezone offset in minutes (JS getTimezoneOffset())
//   before     id of the last row already loaded; returns the next older rows
//
// Answers { rows: [...], hasMore: true|false }.
//
// The log stores the HTTP method and path of every successful change, so the
// "action type" is worked out from those. These SQL pieces are fixed text and
// never contain user input. (The *_delete listing/user keys stay so history from
// before Module 7 can still be filtered.)
const AUDIT_ACTIONS = {
    approve:         "(a.method = 'POST'   AND a.path LIKE '%/landlord-requests/%/approve')",
    reject:          "(a.method = 'POST'   AND a.path LIKE '%/landlord-requests/%/reject')",
    user_edit:       "(a.method = 'PUT'    AND a.path LIKE '%/users/%')",
    user_suspend:    "(a.method = 'POST'   AND a.path LIKE '%/users/%/suspend')",
    user_unsuspend:  "(a.method = 'POST'   AND a.path LIKE '%/users/%/unsuspend')",
    user_delete:     "(a.method = 'DELETE' AND a.path LIKE '%/users/%')",
    listing_hide:    "(a.method = 'POST'   AND a.path LIKE '%/listings/%/hide')",
    listing_unhide:  "(a.method = 'POST'   AND a.path LIKE '%/listings/%/unhide')",
    listing_edit:    "(a.method = 'PUT'    AND a.path LIKE '%/listings/%')",
    listing_delete:  "(a.method = 'DELETE' AND a.path LIKE '%/listings/%')",
    review_delete:   "(a.method = 'DELETE' AND a.path LIKE '%/reviews/%')",
    admin_create:    "(a.method = 'POST'   AND a.path LIKE '%/admins')",
    admin_edit:      "(a.method = 'PUT'    AND a.path LIKE '%/admins/%')",
    admin_delete:    "(a.method = 'DELETE' AND a.path LIKE '%/admins/%')"
};

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Midnight of `ymd` in the admin's timezone, as a real point in time.
// (getTimezoneOffset is negative east of UTC: the Philippines is -480.)
function localMidnight(ymd, tzOffsetMinutes, addDays) {
    const d = new Date(ymd + 'T00:00:00.000Z');
    if (isNaN(d)) return null;
    d.setUTCDate(d.getUTCDate() + (addDays || 0));
    return new Date(d.getTime() + tzOffsetMinutes * 60000);
}

exports.getAuditLog = (req, res) => {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 25));
    const where = [];
    const params = [];

    const adminId = parseInt(req.query.admin_id);
    if (adminId > 0) {
        where.push('a.admin_id = ?');
        params.push(adminId);
    }

    const action = String(req.query.action || '');
    if (AUDIT_ACTIONS[action]) where.push(AUDIT_ACTIONS[action]);

    const tz = Math.min(840, Math.max(-840, parseInt(req.query.tz) || 0));
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    if (DATE_ONLY.test(from)) {
        const start = localMidnight(from, tz, 0);
        if (start) { where.push('a.created_at >= ?'); params.push(start); }
    }
    if (DATE_ONLY.test(to)) {
        const endExclusive = localMidnight(to, tz, 1); // the whole "to" day counts
        if (endExclusive) { where.push('a.created_at < ?'); params.push(endExclusive); }
    }

    const before = parseInt(req.query.before);
    if (before > 0) {
        where.push('a.id < ?');
        params.push(before);
    }

    const sql = `
        SELECT a.id, a.admin_id, a.method, a.path, a.created_at, ad.full_name AS admin_name
        FROM admin_audit_log a
        LEFT JOIN admins ad ON ad.id = a.admin_id
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY a.id DESC
        LIMIT ?
    `;
    // One extra row tells us whether another page exists.
    db.query(sql, [...params, limit + 1], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ rows: rows.slice(0, limit), hasMore: rows.length > limit });
    });
};
