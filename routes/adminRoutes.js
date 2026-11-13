const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');
// limit failed admin logins (see middleware/rateLimit.js) try
const { loginLimiter } = require('../middleware/rateLimit');
// records every change made through the admin panel
const { auditAdminActions } = require('../middleware/auditLog');

// Public - this is what ISSUES the signed admin token
router.post('/login', loginLimiter, adminController.adminLogin);

// Everything below this line requires a valid admin token (x-admin-key header)
router.use(adminController.verifyAdminKey);

// audit trail (must come AFTER the token check so req.adminId exists)
router.use(auditAdminActions);

// Who is signed in (name + email) - powers the top bar
router.get('/me', adminController.getMe);

// Dashboard
router.get('/stats', adminController.getStats);
router.get('/overview', adminController.getOverview);
router.get('/audit-log', adminController.getAuditLog);

// Users - view/edit and suspend/unsuspend. NO delete.
router.get('/users', adminController.getAllUsersAdmin);
router.put('/users/:id', adminController.updateUserAdmin);
router.post('/users/:id/suspend', adminController.suspendUser);
router.post('/users/:id/unsuspend', adminController.unsuspendUser);

// Landlord approval workflow
router.get('/landlord-requests', adminController.getLandlordRequests);
router.get('/landlord-requests/:id/documents', adminController.getLandlordRequestDocs);
router.post('/landlord-requests/:id/approve', adminController.approveLandlord);
router.post('/landlord-requests/:id/reject', adminController.rejectLandlord);

// Listings - view and hide/unhide only. NO edit and NO delete.
router.get('/listings', adminController.getAllListingsAdmin);
router.post('/listings/:id/hide', adminController.hideListing);
router.post('/listings/:id/unhide', adminController.unhideListing);
// NEW: decline a landlord's appeal (the listing stays hidden)
router.post('/listings/:id/dismiss-appeal', adminController.dismissAppeal);

// Reviews (moderation)
router.get('/reviews', adminController.getAllReviewsAdmin);
router.delete('/reviews/:id', adminController.deleteReviewAdmin);

// Admin account management (CRUD for admin accounts themselves)
router.get('/admins', adminController.getAllAdmins);
router.post('/admins', adminController.createAdmin);
router.put('/admins/:id', adminController.updateAdmin);
router.delete('/admins/:id', adminController.deleteAdmin);

module.exports = router;
