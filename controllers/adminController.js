const db = require('../config/db');
const bcrypt = require('bcryptjs');
const { signAdminToken, requireAdmin } = require('../middleware/auth');

const BCRYPT_ROUNDS = 10;
const isBcryptHash = (str) => typeof str === 'string' && /^\$2[aby]\$\d{2}\$/.test(str);
// Same in-memory /api/view cache used by userController.js - admin
// edits/deletes bypass userController.js entirely, so without clearing it
// here too, an admin fixing a listing's price (for example) wouldn't show
// up on the public Browse view until the cache's TTL expired on its own.
const listingsCache = require('../utils/listingsCache');

// --- ADMIN LOGIN ---
// Checks the `admins` DB table. Passwords are bcrypt-hashed. Any admin still
// on a plain-text password is accepted once and upgraded to a hash right then.
// ADMIN_KEY is still the shared secret returned on success (replaced by a
// signed, expiring token in the next security step).
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

        // The "adminKey" the panel stores and sends back in the x-admin-key header
        // is now a SIGNED token that expires after 8 hours (no more shared,
        // never-expiring ADMIN_KEY). admin.js needs no changes.
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

// --- MIDDLEWARE: guards every route below it ---
// Verifies the signed admin token from the x-admin-key header (see
// middleware/auth.js). Same exported name as before, so adminRoutes.js is unchanged.
exports.verifyAdminKey = requireAdmin;

// --- DASHBOARD STATS ---
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

// --- USERS: LIST (with optional search) ---
exports.getAllUsersAdmin = (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const sql = `SELECT id, full_name, email, role, landlord_status, address, contact FROM users WHERE full_name LIKE ? OR email LIKE ? ORDER BY id DESC`;
    db.query(sql, [search, search], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// --- USERS: PENDING LANDLORD REQUESTS ---
// Also selects landlord_doc_name - the name the applicant typed as "printed
// on their Proof of Ownership document". admin.js uses this alongside the
// user's registered full_name to render a Match / Mismatch / No name given
// badge in the Landlord Requests table.
exports.getLandlordRequests = (req, res) => {
    const sql = `SELECT id, full_name, email, contact, address, landlord_documents, landlord_doc_name FROM users WHERE landlord_status = 'pending' ORDER BY id DESC`;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// --- USERS: APPROVE LANDLORD REQUEST ---
// This is the ONLY place a user's role actually becomes 'landlord'.
exports.approveLandlord = (req, res) => {
    const { id } = req.params;
    const sql = `UPDATE users SET role = 'landlord', landlord_status = 'approved', landlord_rejection_reason = NULL WHERE id = ?`;
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear(); // NEW: landlord_status (Verified badge) is shown on cached listings
        res.json({ success: true, message: 'Landlord request approved' });
    });
};

// --- USERS: REJECT LANDLORD REQUEST ---
// Accepts whatever string is passed as `reason` in the request body.
// admin.js builds that string from a template picker (or custom text).
exports.rejectLandlord = (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const finalReason = (reason && reason.trim() !== "") ? reason.trim() : "Your submitted documents did not meet our requirements.";

    const sql = `UPDATE users SET landlord_status = 'rejected', landlord_rejection_reason = ? WHERE id = ?`;
    db.query(sql, [finalReason, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear(); // NEW
        res.json({ success: true, message: 'Landlord request rejected' });
    });
};

// --- USERS: FULL ADMIN EDIT (CRUD - Update) ---
exports.updateUserAdmin = (req, res) => {
    const { id } = req.params;
    const { full_name, email, role, address, contact, landlord_status } = req.body;

    const sql = `UPDATE users SET full_name=?, email=?, role=?, address=?, contact=?, landlord_status=? WHERE id=?`;
    db.query(sql, [full_name, email, role, address, contact, landlord_status, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear(); // NEW: landlord name/status shown on cached listings may have changed
        res.json({ success: true, message: 'User updated successfully' });
    });
};

// --- USERS: DELETE (CRUD - Delete) ---
exports.deleteUserAdmin = (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        listingsCache.clear(); // NEW: this user's listings may no longer appear in /api/view
        res.json({ success: true, message: 'User deleted successfully' });
    });
};

// --- LISTINGS: LIST ALL (admin sees everyone's listings) ---
exports.getAllListingsAdmin = (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const sql = `
        SELECT l.*, u.full_name AS landlord_name, u.email AS landlord_email
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

// --- LISTINGS: UPDATE (no ownership check needed, admin overrides) ---
exports.updateListingAdmin = (req, res) => {
    const { id } = req.params;
    const { title, category, price, location, rooms, size, amenities } = req.body;
    const sql = `UPDATE listings SET title=?, category=?, price=?, location=?, rooms=?, size=?, amenities=? WHERE id=?`;
    db.query(sql, [title, category, price, location, rooms, size, amenities, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Listing not found' });
        listingsCache.clear(); // keep the public Browse view in sync with this admin edit
        res.json({ success: true, message: 'Listing updated successfully' });
    });
};

// --- LISTINGS: DELETE (admin override, ignores ownership) ---
exports.deleteListingAdmin = (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM listings WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Listing not found' });
        listingsCache.clear(); // don't let a cached /api/view keep showing a listing an admin just removed
        res.json({ success: true, message: 'Listing deleted successfully' });
    });
};

// --- REVIEWS: LIST ALL ---
exports.getAllReviewsAdmin = (req, res) => {
    const sql = `SELECT r.*, l.title AS listing_title FROM reviews r LEFT JOIN listings l ON r.listing_id = l.id ORDER BY r.created_at DESC`;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// --- REVIEWS: DELETE (moderation) ---
exports.deleteReviewAdmin = (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM reviews WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Review not found' });
        listingsCache.clear(); // a deleted review can change the listing's avg_rating/review_count
        res.json({ success: true, message: 'Review deleted successfully' });
    });
};

// --- ADMIN ACCOUNT MANAGEMENT (CRUD for admin accounts themselves) ---
// Powers the "Settings" panel in admin.html, letting a logged-in admin
// create/edit/delete OTHER admin accounts.

// LIST all admins (id, name, email, created_at only - never sends passwords)
exports.getAllAdmins = (req, res) => {
    const sql = `SELECT id, full_name, email, created_at FROM admins ORDER BY id ASC`;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// CREATE a new admin account (password is stored as a bcrypt hash)
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
                // MySQL duplicate-key error code, thrown by the UNIQUE constraint on email
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

// UPDATE an existing admin account. Password is optional on edit - leaving
// it blank on the frontend keeps the existing password unchanged.
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

// DELETE an admin account. Guard: never allow deleting the last remaining
// admin, or the panel becomes permanently inaccessible to everyone.
exports.deleteAdmin = (req, res) => {
    const { id } = req.params;

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
// ============================================================================
//  ADMIN PANEL UPGRADE - everything BELOW this line is NEW.
//  Everything above this line is your original code, unchanged.
//
//  In Node, a later `exports.x = ...` replaces an earlier one, so the versions
//  below take over from the originals without removing them.
// ============================================================================
// ============================================================================

// --- LANDLORD REQUESTS (lighter list) ---------------------------------------
// Replaces the original getLandlordRequests. It NO LONGER sends the huge
// base64 landlord_documents for every pending applicant. The documents are
// fetched one applicant at a time by getLandlordRequestDocs below, only when an
// admin clicks "View Docs".
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

// NEW: documents for ONE applicant (GET /api/admin/landlord-requests/:id/documents)
exports.getLandlordRequestDocs = (req, res) => {
    const { id } = req.params;
    db.query('SELECT landlord_documents FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ documents: rows[0].landlord_documents || '' });
    });
};

// --- LISTINGS (lighter list) ------------------------------------------------
// Replaces the original getAllListingsAdmin. Picks only the columns the panel
// needs (no photo blobs). `thumbnail` is only sent when it's a short URL, so
// old base64 thumbnails never bloat the response.
exports.getAllListingsAdmin = (req, res) => {
    const search = req.query.search ? `%${req.query.search}%` : '%';
    const sql = `
        SELECT l.id, l.user_id, l.title, l.category, l.price, l.location, l.rooms, l.size,
               l.amenities, l.status, l.created_at,
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

// --- OVERVIEW CHARTS (GET /api/admin/overview) ------------------------------
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

// --- ACTIVITY LOG (GET /api/admin/audit-log?limit=100) ----------------------
exports.getAuditLog = (req, res) => {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50));
    const sql = `
        SELECT a.id, a.method, a.path, a.created_at, ad.full_name AS admin_name
        FROM admin_audit_log a
        LEFT JOIN admins ad ON ad.id = a.admin_id
        ORDER BY a.id DESC
        LIMIT ?
    `;
    db.query(sql, [limit], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// --- VALIDATION: editing a user ---------------------------------------------
// Wraps the original updateUserAdmin: bad values are rejected BEFORE the
// original code runs, so nothing invalid reaches the database.
const _originalUpdateUserAdmin = exports.updateUserAdmin;
const VALID_ROLES = ['tenant', 'landlord', 'pending'];
const VALID_LANDLORD_STATUSES = ['none', 'pending', 'approved', 'rejected'];

exports.updateUserAdmin = (req, res) => {
    const { full_name, email, role, landlord_status } = req.body || {};

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

    return _originalUpdateUserAdmin(req, res);
};

// --- GUARD: an admin can't delete their OWN account -------------------------
// The panel already disables that button, but anyone calling the API directly
// could skip it. Now the server refuses too.
const _originalDeleteAdmin = exports.deleteAdmin;

exports.deleteAdmin = (req, res) => {
    if (String(req.params.id) === String(req.adminId)) {
        return res.status(400).json({ success: false, message: "You can't delete your own admin account while logged in." });
    }
    return _originalDeleteAdmin(req, res);
};
