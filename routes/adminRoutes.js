const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Public — no key required yet, this is what ISSUES the key
router.post('/login', adminController.adminLogin);

// Everything below this line requires a valid x-admin-key header
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

module.exports = router;
