const mysql = require('mysql2');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: 3306, 
    waitForConnections: true,
    // UPDATED: was 10. Clever Cloud's free DEV database only allows 5
    // connections per user ("max_user_connections"), and Render runs the old
    // and new server at the same time during a deploy, so 10 could never fit.
    // Requests beyond this limit now simply wait in line (queueLimit: 0 means
    // the waiting line has no size limit) instead of failing.
    connectionLimit: 3,
    // NEW: give unused connections back quickly so they don't hog the 5 slots.
    maxIdle: 2,
    idleTimeout: 30000, // close a connection after 30 seconds without use
    // NEW: keeps open connections alive so the database host doesn't silently drop them.
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    queueLimit: 0
});

// ADD THIS: Verification test
pool.getConnection((err, connection) => {
    if (err) {
        console.error('❌ Database connection failed:', err.message);
    } else {
        console.log('✅ Connected to Clever Cloud MySQL!');
        connection.release(); // Release back to pool
    }
});

module.exports = pool;
