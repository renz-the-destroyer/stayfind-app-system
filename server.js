// API FRAMEWORK
const express = require('express');
// CROSS ORIGIN RESOURCE SHARING
const cors = require('cors');
// ENVIRONMENT VARIABLES
require('dotenv').config();
// DATABASE CONNECTION
const db = require('./config/db');
// ROUTES
const routes = require('./routes/index.js');
// NEW: Admin routes (separate router, protected by ADMIN_KEY)
const adminRoutes = require('./routes/adminRoutes');
// UTILIZATION OF EXPRESS
const app = express();

// MIDDLEWARES
app.use(cors());
// UPDATED: Increased limit to 50mb to allow Base64 image uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// REMOVED (dead-code cleanup): this file used to have its own inline
// handlers for POST /api/smart-search, POST /api/toggle-bookmark,
// GET /api/get-bookmarks/:userId, and POST /api/update-listing, registered
// directly on `app` right here, BEFORE `app.use('/api', routes)` below.
// Express matches whichever handler for a path is registered first, so
// these four always ran instead of the versions of the same routes defined
// in routes/index.js -> controllers/userController.js - making those four
// controller functions permanently unreachable dead code, even though they
// were kept updated in parallel the whole time.
//
// All four now live in controllers/userController.js only (smartSearch,
// toggleBookmark, getBookmarks, updateListing), reached through the routes
// mounted below, same as every other endpoint in this app. Before removing
// this inline version of update-listing, the controller's version was
// missing the thumbnail/images COALESCE update and the oversized-payload
// guard that this version had - both have been added there so nothing about
// photo editing changed for the user.

// USE ROUTES
app.use('/api', routes);
// NEW: Mount admin routes under /api/admin. Anything hitting
// /api/admin/login, /api/admin/stats, /api/admin/users, etc. is handled by
// adminRoutes.js -> adminController.js. This is what admin.js's API_BASE
// ("https://stayfind-app-system.onrender.com/api/admin") depends on.
app.use('/api/admin', adminRoutes);

// Global error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!' });
});

// PORT SETTING
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
