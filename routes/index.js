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

// --- 5. PROFILE & DASHBOARD ROUTES ---
// This handles the Dashboard setup and the new Settings Modal in home.html
router.post('/update-profile', userController.updateProfile);

module.exports = router;
