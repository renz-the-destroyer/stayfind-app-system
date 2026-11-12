// middleware/auth.js
//
// Signed, expiring login tokens (JWT) for both normal users and admins.
//
// - Users get a token (7 days) from POST /api/login and POST /api/add.
//   The frontend sends it as:  Authorization: Bearer <token>
// - Admins get a token (2 hours) from POST /api/admin/login. admin.js sends
//   whatever the login returned in the `x-admin-key` header.
//
// Needs ONE environment variable: JWT_SECRET (a long random string, 32+ chars).
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

const jwt = require('jsonwebtoken');
const db = require('../config/db');

const USER_TOKEN_TTL = '7d';
const ADMIN_TOKEN_TTL = '2h';

// NEW (Module 7): ids of suspended users, kept in memory so a suspension takes
// effect on the very next request without a database query per request.
// Loaded once at startup, then updated by markSuspended / markActive.
const suspendedIds = new Set();
db.query('SELECT id FROM users WHERE is_suspended = 1', (err, rows) => {
    if (err) {
        console.error('Could not load suspended users (did you run the Module 7 SQL?):', err.message);
        return;
    }
    rows.forEach(r => suspendedIds.add(Number(r.id)));
});
exports.markSuspended = (id) => suspendedIds.add(Number(id));
exports.markActive = (id) => suspendedIds.delete(Number(id));

function getSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
        console.error('JWT_SECRET is missing or shorter than 32 characters. Set it in Render -> Environment.');
        throw new Error('Server auth is not configured.');
    }
    return secret;
}

exports.signUserToken = (user) =>
    jwt.sign({ sub: String(user.id), typ: 'user' }, getSecret(), { expiresIn: USER_TOKEN_TTL });

exports.signAdminToken = (admin) =>
    jwt.sign({ sub: String(admin.id), typ: 'admin' }, getSecret(), { expiresIn: ADMIN_TOKEN_TTL });

// Protects a route: only a logged-in user gets through, and req.userId is set
// from the SIGNED token - never from the request body.
exports.requireUser = (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ success: false, message: 'Please log in.' });

    let payload;
    try {
        payload = jwt.verify(token, getSecret());
        if (payload.typ !== 'user') throw new Error('wrong token type');
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Your session has expired. Please log in again.' });
    }

    const id = Number(payload.sub);
    // NEW (Module 7): a suspended user is signed out on their next request.
    if (suspendedIds.has(id)) {
        return res.status(401).json({ success: false, message: 'Your account has been suspended.' });
    }
    req.userId = id;
    next();
};

// For PUBLIC routes that show a bit more to logged-in people. No token, a bad or
// expired one, or a suspended user simply means "guest". It never answers 401.
exports.optionalUser = (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

    if (token) {
        try {
            const payload = jwt.verify(token, getSecret());
            const id = Number(payload.sub);
            if (payload.typ === 'user' && !suspendedIds.has(id)) req.userId = id;
        } catch (err) {
            /* invalid or expired token: treat as a guest */
        }
    }
    next();
};

// Protects the /api/admin routes (token comes in the x-admin-key header).
exports.requireAdmin = (req, res, next) => {
    const token = req.headers['x-admin-key'];
    if (!token) return res.status(401).json({ success: false, message: 'Unauthorized: missing admin token' });

    try {
        const payload = jwt.verify(token, getSecret());
        if (payload.typ !== 'admin') throw new Error('wrong token type');
        req.adminId = Number(payload.sub);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Unauthorized: invalid or expired admin token' });
    }
};
