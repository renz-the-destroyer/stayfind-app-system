const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

// --- 1. API HEALTH CHECK ---
// You can visit https://stayfind-app-system.onrender.com/api/test to see if it's working
router.get('/test', (req, res) => res.json({ message: "API is Online and Connected!" }));

// --- 2. LISTING & USER VIEWING ROUTES ---
// This matches your home.js loadListings() fetch - now pointed to property listings
router.get('/view', userController.getAllListings); 
router.get('/view/:id', userController.getUserById);

// ADDED: Specific route for Login/Authentication to fetch the user table
router.get('/users', userController.getAllUsers);

// --- 3. ACCOUNT CREATION & MANAGEMENT ---
router.post('/add', userController.createUser);
router.put('/update', userController.updateUser);
router.delete('/delete', userController.deleteUser);

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

module.exports = router;
