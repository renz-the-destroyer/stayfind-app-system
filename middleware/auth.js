// middleware/auth.js
//
// Signed, expiring login tokens (JWT) for both normal users and admins.
//
// - Users get a token (7 days) from POST /api/login and POST /api/add.
//   The frontend sends it as:  Authorization: Bearer <token>
// - Admins get a token (8 hours) from POST /api/admin/login. admin.js already
//   sends whatever the login returned in the `x-admin-key` header, so the
//   admin panel needs NO changes.
//
// Needs ONE environment variable: JWT_SECRET (a long random string, 32+ chars).
// Generate one with:
//   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

const jwt = require('jsonwebtoken');

const USER_TOKEN_TTL = '7d';
const ADMIN_TOKEN_TTL = '8h';

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
// from the SIGNED token - never from the request body, so nobody can act as
// somebody else by changing a user_id/email field.
exports.requireUser = (req, res, next) => {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return res.status(401).json({ success: false, message: 'Please log in.' });

    try {
        const payload = jwt.verify(token, getSecret());
        if (payload.typ !== 'user') throw new Error('wrong token type');
        req.userId = Number(payload.sub);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Your session has expired. Please log in again.' });
    }
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
