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

// UTILIZATION OF EXPRESS
const app = express();

// MIDDLEWARES
app.use(cors());
// UPDATED: Increased limit to 50mb to allow Base64 image uploads
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// USE ROUTES
// Dahil '/api' ang prefix mo, ang endpoints mo ay magiging:
// https://your-app.onrender.com/api/add
// https://your-app.onrender.com/api/view
app.use('/api', routes);

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
