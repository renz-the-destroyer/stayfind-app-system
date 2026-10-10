// controllers/authController.js
//
// POST /api/login
// Body: { email, password }
// Returns: { success: true, user } on success (user WITHOUT password or
// landlord_documents), or 401 { success: false, message } on failure.
//
// Passwords are checked on the SERVER now. The browser never receives the
// users table anymore.
//
// Existing accounts still have plain-text passwords in the DB. On a
// successful login with a plain-text password, it is hashed with bcrypt and
// saved right then, so every account upgrades itself the first time its
// owner signs in - no migration script needed.

const bcrypt = require('bcryptjs');
const db = require('../config/db');

const BCRYPT_ROUNDS = 10;
const isBcryptHash = (s) => typeof s === 'string' && /^\$2[aby]\$\d{2}\$/.test(s);

exports.login = (req, res) => {
    const email = (req.body.email || '').toString().trim().toLowerCase();
    const password = (req.body.password || '').toString();

    if (!email || !password) {
        return res.status(400).json({ success: false, message: 'Email and password are required.' });
    }

    db.query('SELECT * FROM users WHERE LOWER(email) = ? LIMIT 1', [email], async (err, rows) => {
        if (err) {
            console.error('Login query error:', err.message);
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }

        // Same message for "no such email" and "wrong password" so the
        // endpoint can't be used to find out which emails are registered.
        const invalid = () => res.status(401).json({ success: false, message: 'Invalid email or password.' });

        const user = rows[0];
        if (!user) return invalid();

        let ok = false;
        try {
            if (isBcryptHash(user.password)) {
                ok = await bcrypt.compare(password, user.password);
            } else if (String(user.password || '').trim() === password.trim()) {
                // Legacy plain-text password: accept it once, then upgrade it.
                ok = true;
                const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
                db.query('UPDATE users SET password = ? WHERE id = ?', [newHash, user.id], (updErr) => {
                    if (updErr) console.error('Password upgrade failed:', updErr.message);
                });
            }
        } catch (e) {
            console.error('Login hash error:', e.message);
            return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
        }

        if (!ok) return invalid();

        delete user.password;
        delete user.landlord_documents; // big base64 blobs the browser never needs
        res.json({ success: true, user });
    });
};
