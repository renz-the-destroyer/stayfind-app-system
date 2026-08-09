const db = require('../config/db');

// --- ADMIN LOGIN ---
// Checks against the ADMIN_EMAIL/ADMIN_PASSWORD in .env and hands back the
// ADMIN_KEY, which the frontend stores and sends on every later request.
exports.adminLogin = (req, res) => {
    const { email, password } = req.body;

    if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
        return res.json({ success: true, adminKey: process.env.ADMIN_KEY });
    }
    return res.status(401).json({ success: false, message: 'Invalid admin credentials' });
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
// UPDATED: now also selects landlord_documents so the admin can review the
// uploaded verification docs (Proof of Ownership, Local Permits, BIR
// Registration) before approving/rejecting.
exports.getLandlordRequests = (req, res) => {
    const sql = `SELECT id, full_name, email, contact, address, landlord_documents FROM users WHERE landlord_status = 'pending' ORDER BY id DESC`;
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// --- USERS: APPROVE LANDLORD REQUEST ---
// This is the ONLY place a user's role actually becomes 'landlord'.
// UPDATED: also clears any previous rejection reason, so an old rejection
// note doesn't linger on the account after a later approval.
exports.approveLandlord = (req, res) => {
    const { id } = req.params;
    const sql = `UPDATE users SET role = 'landlord', landlord_status = 'approved', landlord_rejection_reason = NULL WHERE id = ?`;
    db.query(sql, [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
        res.json({ success: true, message: 'Landlord request approved' });
    });
};

// --- USERS: REJECT LANDLORD REQUEST ---
// UPDATED: now accepts a `reason` in the request body (typed by the admin in
// the panel) and stores it in landlord_rejection_reason. This is what
// home.js reads back and shows to the user in a notification, so they know
// exactly what to fix before trying again. Falls back to a generic message
// if no reason was provided (shouldn't normally happen since admin.js now
// requires one).
exports.rejectLandlord = (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    const finalReason = (reason && reason.trim() !== "") ? reason.trim() : "Your submitted documents did not meet our requirements.";

    const sql = `UPDATE users SET landlord_status = 'rejected', landlord_rejection_reason = ? WHERE id = ?`;
    db.query(sql, [finalReason, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
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
        res.json({ success: true, message: 'User updated successfully' });
    });
};

// --- USERS: DELETE (CRUD - Delete) ---
exports.deleteUserAdmin = (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'User not found' });
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
        res.json({ success: true, message: 'Listing updated successfully' });
    });
};

// --- LISTINGS: DELETE (admin override, ignores ownership) ---
exports.deleteListingAdmin = (req, res) => {
    const { id } = req.params;
    db.query('DELETE FROM listings WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows === 0) return res.status(404).json({ message: 'Listing not found' });
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
        res.json({ success: true, message: 'Review deleted successfully' });
    });
};
