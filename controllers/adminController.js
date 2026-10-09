const db = require('../config/db');
// Same in-memory /api/view cache used by userController.js - admin
// edits/deletes bypass userController.js entirely, so without clearing it
// here too, an admin fixing a listing's price (for example) wouldn't show
// up on the public Browse view until the cache's TTL expired on its own.
const listingsCache = require('../utils/listingsCache');

// --- ADMIN LOGIN ---
// Checks the `admins` DB table so multiple admin accounts can exist and log
// in independently. ADMIN_KEY is still the shared secret returned on success
// and required on every other admin route.
exports.adminLogin = (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    const sql = `SELECT id, full_name, email FROM admins WHERE email = ? AND password = ?`;
    db.query(sql, [email, password], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
        }
        return res.json({ success: true, adminKey: process.env.ADMIN_KEY, admin: rows[0] });
    });
};

// --- MIDDLEWARE: guards every route below it ---
exports.verifyAdminKey = (req, res, next) => {
    const key = req.headers['x-admin-key'];
    if (!key || key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ success: false, message: 'Unauthorized: invalid or missing admin key' });
    }
    next();
};

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

// CREATE a new admin account
exports.createAdmin = (req, res) => {
    const { full_name, email, password } = req.body;

    if (!full_name || !email || !password) {
        return res.status(400).json({ success: false, message: 'Full name, email, and password are all required.' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password must be at least 6 characters.' });
    }

    const sql = `INSERT INTO admins (full_name, email, password) VALUES (?, ?, ?)`;
    db.query(sql, [full_name, email, password], (err, result) => {
        if (err) {
            // MySQL duplicate-key error code, thrown by the UNIQUE constraint on email
            if (err.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({ success: false, message: 'An admin with that email already exists.' });
            }
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Admin account created successfully', id: result.insertId });
    });
};

// UPDATE an existing admin account. Password is optional on edit - leaving
// it blank on the frontend keeps the existing password unchanged.
exports.updateAdmin = (req, res) => {
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
        finishUpdate(`UPDATE admins SET full_name=?, email=?, password=? WHERE id=?`, [full_name, email, password, id]);
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
