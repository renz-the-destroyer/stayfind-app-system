// middleware/auditLog.js
//
// Records every successful change (POST / PUT / DELETE) made through the
// admin panel: which admin, what was requested, and when. Request bodies are
// NEVER stored, so passwords and documents never end up in the log.
//
// NEW: controllers can set res.locals.auditLabel (e.g. the listing title or the
// user's name). It is saved as target_label so the Activity Log can show real
// names, even if the listing or user changes later.
//
// The table and the target_label column are created automatically at startup.

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
    if (err) {
        console.error('Could not create admin_audit_log table:', err.message);
        return;
    }
    db.query('ALTER TABLE admin_audit_log ADD COLUMN target_label VARCHAR(255) NULL', (alterErr) => {
        // ER_DUP_FIELDNAME just means the column already exists.
        if (alterErr && alterErr.code !== 'ER_DUP_FIELDNAME') {
            console.error('Could not add target_label to admin_audit_log:', alterErr.message);
        }
    });
});

// Mount AFTER the admin token check, so req.adminId is already set.
exports.auditAdminActions = (req, res, next) => {
    if (req.method === 'GET') return next();

    res.on('finish', () => {
        if (res.statusCode >= 400) return; // only log changes that actually happened
        const path = String(req.originalUrl || '').split('?')[0].slice(0, 255);
        const label = res.locals && res.locals.auditLabel ? String(res.locals.auditLabel).slice(0, 255) : null;
        db.query(
            'INSERT INTO admin_audit_log (admin_id, method, path, status_code, target_label) VALUES (?, ?, ?, ?, ?)',
            [req.adminId || null, req.method, path, res.statusCode, label],
            (err) => { if (err) console.error('Audit log insert failed:', err.message); }
        );
    });

    next();
};
