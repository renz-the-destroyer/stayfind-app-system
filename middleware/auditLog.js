// middleware/auditLog.js
//
// Records every successful change (POST / PUT / DELETE) made through the
// admin panel: which admin, what was requested, and when. Request bodies are
// NEVER stored, so passwords and documents never end up in the log.
//
// The table is created automatically the first time the server starts.

const db = require('../config/db');

db.query(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        admin_id INT NULL,
        method VARCHAR(8) NOT NULL,
        path VARCHAR(255) NOT NULL,
        status_code SMALLINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_created (created_at)
    )
`, (err) => {
    if (err) console.error('Could not create admin_audit_log table:', err.message);
});

// Mount AFTER the admin token check, so req.adminId is already set.
exports.auditAdminActions = (req, res, next) => {
    if (req.method === 'GET') return next();

    res.on('finish', () => {
        if (res.statusCode >= 400) return; // only log changes that actually happened
        const path = String(req.originalUrl || '').split('?')[0].slice(0, 255);
        db.query(
            'INSERT INTO admin_audit_log (admin_id, method, path, status_code) VALUES (?, ?, ?, ?)',
            [req.adminId || null, req.method, path, res.statusCode],
            (err) => { if (err) console.error('Audit log insert failed:', err.message); }
        );
    });

    next();
};
