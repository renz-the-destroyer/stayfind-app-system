const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306, 
    waitForConnections: true,
    // Clever Cloud's free DEV database only allows 5 connections per user, and try
    // Render runs the old and new server at the same time during a deploy.
    connectionLimit: 3,
    maxIdle: 2,
    idleTimeout: 30000, // close a connection after 30 seconds without use
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    queueLimit: 0,
    // NEW: Node reads and writes dates as UTC...
    timezone: 'Z'
});

// NEW: ...and every database connection is forced to UTC too, so dates, NOW()
// and the Activity Log date filter can never disagree about the timezone.
pool.on('connection', (connection) => {
    connection.query("SET time_zone = '+00:00'");
});

// Verification test
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Connected to Clever Cloud MySQL!');
        connection.release(); // Release back to pool
    }
});

module.exports = pool;
