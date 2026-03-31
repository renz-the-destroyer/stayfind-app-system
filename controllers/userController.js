const db = require('../config/db');

// 1. GET ALL USERS (Used for Login)
exports.getAllUsers = (req, res) => {
    // FIXED: Querying the users table instead of listings
    const sql = "SELECT * FROM users";
    
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 2. CREATE NEW USER (Used for Sign Up)
exports.createUser = (req, res) => {
    // FIXED: Destructuring fields to match your signup form and DB columns
    const { full_name, email, password, role } = req.body;
    
    const sql = `INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, ?)`;
    
    db.query(sql, [full_name, email, password, role], (err, result) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ success: true, message: 'Account Created Successfully', id: result.insertId });
    });
};

// 3. UPDATE USER PROFILE
exports.updateProfile = (req, res) => {
    const { full_name, address, contact, role, email } = req.body;
    const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ? WHERE email = ?`;
    
    db.query(sql, [full_name, address, contact, role, email], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Profile updated successfully' });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    });
};

// --- Note: I kept these for your future listing features ---
exports.getUserById = (req, res) => {
    const id = req.params.id;
    db.query('SELECT * FROM listings WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows[0] || { message: 'Not found' });
    });
};
