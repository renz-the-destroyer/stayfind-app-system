const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
const searchController = require('../controllers/searchController');
const authController = require('../controllers/authController');
// NEW: brute-force / spam limits (see middleware/rateLimit.js)
const { loginLimiter, signupLimiter } = require('../middleware/rateLimit');
// NEW: login-token check (JWT) - see middleware/auth.js
// optionalUser = lets guests through but still recognises logged-in users
const { requireUser, optionalUser } = require('../middleware/auth');
// NEW: cleans text fields and validates photo/document data (see middleware/sanitize.js)
const { sanitizeBody } = require('../middleware/sanitize');

// NEW: runs on EVERY request below (including sign up), before any controller.
router.use(sanitizeBody);

// NEW (guest mode): guests must never receive a landlord's phone number or
// email. This wraps res.json for the listings feed: when nobody is logged in,
// those two fields are removed from every listing before the response leaves
// the server. It builds NEW objects, so the shared in-memory listings cache
// (utils/listingsCache.js) is never modified and logged-in users still get
// the full data.
function hideContactFromGuests(req, res, next) {
    if (req.userId) return next();

    const originalJson = res.json.bind(res);
    res.json = (body) => {
        if (body && Array.isArray(body.listings)) {
            body = {
                ...body,
                listings: body.listings.map(({ landlord_contact, landlord_email, ...rest }) => rest)
            };
        }
        return originalJson(body);
    };
    next();
}

// ===================== PUBLIC ROUTES (no login needed) =====================

// API health check
router.get('/test', (req, res) => res.json({ message: "API is Online and Connected!" }));

// Server-side login (bcrypt) - returns the user + a signed token
router.post('/login', loginLimiter, authController.login);

// Sign up (the account is always created with role 'pending')
router.post('/add', signupLimiter, userController.createUser);

// NEW (guest mode): anyone can browse listings and read reviews.
// Guests get listings WITHOUT landlord contact/email (see above).
router.get('/view', optionalUser, hideContactFromGuests, userController.getAllListings);
router.get('/get-reviews/:listing_id', userController.getReviews);

// ===================== EVERYTHING BELOW NEEDS A VALID LOGIN TOKEN =====================
// The frontend (auth-fetch.js) sends "Authorization: Bearer <token>" on every call.
// Controllers take the user's identity from the token (req.userId), never from
// ids/emails in the request body, so nobody can act as somebody else.
router.use(requireUser);

// --- LISTINGS ---
router.get('/view/:id', userController.getUserById); // your own profile only
router.post('/add-listing', userController.addListing);
router.delete('/delete-listing/:id', userController.deleteListing);
router.post('/update-listing', userController.updateListing);

// --- PROFILE ---
router.post('/update-profile', userController.updateProfile);

// --- REVIEWS & RATINGS ---
router.post('/add-review', userController.addReview);

// --- BOOKMARKS ---
router.post('/toggle-bookmark', userController.toggleBookmark);
router.get('/get-bookmarks/:id', userController.getBookmarks);

// --- SMART SEARCH ---
router.post('/smart-search', userController.smartSearch);
router.post('/smart-search/suggestions', searchController.smartSearchSuggestions);

// --- MESSAGING ---
router.post('/conversations/start', userController.startConversation);
router.get('/conversations/:userId', userController.getConversations);
router.get('/messages/:conversationId', userController.getMessages);
router.post('/messages/send', userController.sendMessage);

module.exports = router;
