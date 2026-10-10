const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');
// NEW: zero-result Smart Search suggestions
const searchController = require('../controllers/searchController');
// NEW: server-side login (bcrypt)
const authController = require('../controllers/authController');

// --- 1. API HEALTH CHECK ---
// You can visit https://stayfind-app-system.onrender.com/api/test to see if it's working
router.get('/test', (req, res) => res.json({ message: "API is Online and Connected!" }));

// --- 2. LISTING & USER VIEWING ROUTES ---
// This matches your home.js loadListings() fetch - now pointed to property listings
router.get('/view', userController.getAllListings); 
router.get('/view/:id', userController.getUserById);

// NEW: server-side login. REPLACES the old GET /users, which sent every
// user's password (and landlord documents) to the browser.
router.post('/login', authController.login);

// --- 3. ACCOUNT CREATION & MANAGEMENT ---
router.post('/add', userController.createUser);
// REMOVED: PUT /update and DELETE /delete had no auth at all (anyone could edit
// or delete any user by id) and nothing in the frontend calls them.

// --- 4. PROPERTY LISTING ROUTES ---
// This handles the "Publish Listing" button from home.js
router.post('/add-listing', userController.addListing);

// NEW: Delete a specific listing (Called by deleteListing() in home.js)
router.delete('/delete-listing/:id', userController.deleteListing);

// --- 5. PROFILE & DASHBOARD ROUTES ---
// This handles the Dashboard setup and the new Settings Modal in home.html
router.post('/update-profile', userController.updateProfile);

// --- 6. REVIEWS & RATINGS ROUTES ---
// NEW: Post a new comment or star rating
router.post('/add-review', userController.addReview);

// NEW: Fetch all reviews for a specific listing (Called when opening detailsModal)
router.get('/get-reviews/:listing_id', userController.getReviews);


// --- UPDATED ADDITIONS BELOW (DO NOT REMOVE PREVIOUS CODES) ---

// 7. UPDATE PROPERTY LISTING (Required for Edit Mode in home.js)
router.post('/update-listing', userController.updateListing);

// 8. BOOKMARK SYSTEM (Required for heart icon persistence in home.js)
// Toggle add/remove bookmark
router.post('/toggle-bookmark', userController.toggleBookmark);

// Fetch saved bookmarks for sync
router.get('/get-bookmarks/:id', userController.getBookmarks);

// --- 9. SMART SEARCH SYSTEM (NEW) ---
// Handles natural language like "3 rooms" or "house under 5000"
router.post('/smart-search', userController.smartSearch);

// NEW: when a Smart Search finds nothing, the frontend asks this endpoint
// which loosened versions of the query WOULD find something.
router.post('/smart-search/suggestions', searchController.smartSearchSuggestions);

// --- 10. MESSAGING SYSTEM (NEW) ---
// Tenant <-> landlord direct messages. See the big comment block above
// exports.startConversation in controllers/userController.js for the two
// new tables this needs (conversations, messages).
router.post('/conversations/start', userController.startConversation);
router.get('/conversations/:userId', userController.getConversations);
router.get('/messages/:conversationId', userController.getMessages);
router.post('/messages/send', userController.sendMessage);

module.exports = router;
