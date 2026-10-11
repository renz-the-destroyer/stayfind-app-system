const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
// NEW: limit failed admin logins (see middleware/rateLimit.js)
const { loginLimiter } = require('../middleware/rateLimit');

// Public - this is what ISSUES the signed admin token
router.post('/login', loginLimiter, adminController.adminLogin);

// Everything below this line requires a valid admin token (x-admin-key header)
router.use(adminController.verifyAdminKey);

// Dashboard
router.get('/stats', adminController.getStats);

// Users
router.get('/users', adminController.getAllUsersAdmin);
router.put('/users/:id', adminController.updateUserAdmin);
router.delete('/users/:id', adminController.deleteUserAdmin);

// Landlord approval workflow
router.get('/landlord-requests', adminController.getLandlordRequests);
router.post('/landlord-requests/:id/approve', adminController.approveLandlord);
router.post('/landlord-requests/:id/reject', adminController.rejectLandlord);

// Listings
router.get('/listings', adminController.getAllListingsAdmin);
router.put('/listings/:id', adminController.updateListingAdmin);
router.delete('/listings/:id', adminController.deleteListingAdmin);

// Reviews (moderation)
router.get('/reviews', adminController.getAllReviewsAdmin);
router.delete('/reviews/:id', adminController.deleteReviewAdmin);

// Admin account management (CRUD for admin accounts themselves)
router.get('/admins', adminController.getAllAdmins);
router.post('/admins', adminController.createAdmin);
router.put('/admins/:id', adminController.updateAdmin);
router.delete('/admins/:id', adminController.deleteAdmin);

module.exports = router;
