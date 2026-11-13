// middleware/rateLimit.js
//
// Brute-force / spam protection. Limits are per IP address.
// Needs `app.set('trust proxy', 1)` in server.js: Render puts a proxy in front
// of the app, and without it every visitor would look like the same IP.
//
// Install:  npm install express-rate-limit

const { rateLimit } = require('express-rate-limit');

const tooMany = (message) => ({ success: false, message });

// Login (users and admins): 10 FAILED attempts per 15 minutes. Successful
// logins don't count, so normal use is never blocked.
exports.loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany('Too many failed login attempts. Please try again in 15 minutes.')
});

// Creating accounts: 10 per hour.
exports.signupLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany('Too many sign-up attempts. Please try again later.')
});

// NEW: sending chat messages: 20 per minute.
exports.messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany('You are sending messages too fast. Please slow down.')
});

// NEW: posting reviews, comments and replies: 15 per 10 minutes.
exports.reviewLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 15,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany('Too many reviews or comments in a short time. Please try again later.')
});

// NEW: appeals for hidden listings: 5 per hour.
exports.appealLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: tooMany('Too many appeals. Please try again later.')
});
