const connection = require('../db.js');

// 1. GET ALL LISTINGS
exports.getAllUsers = (req, res) => {
    const sql = `
        SELECT l.*, u.full_name as landlordName, u.contact 
        FROM listings l 
        JOIN users u ON l.user_id = u.id 
        ORDER BY l.id DESC`;
        
    connection.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 2. SEARCH BY ID
exports.getUserById = (req, res) => {
    const id = req.params.id;
    connection.query('SELECT * FROM listings WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ message: 'Listing not found' });
        }
    });
};

// 3. CREATE NEW LISTING
exports.createUser = (req, res) => {
    const { title, category, price, location, rooms, size, amenities, user_id } = req.body;
    const sql = `INSERT INTO listings 
                (title, category, price, location, rooms, size, amenities, user_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    
    connection.query(sql, [title, category, price, location, rooms, size, amenities, user_id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Listing Created Successfully', id: result.insertId });
    });
};

// 4. UPDATE LISTING
exports.updateUser = (req, res) => {
    const { id, title, category, price, location, rooms, size, amenities } = req.body;
    const sql = `UPDATE listings 
                SET title = ?, category = ?, price = ?, location = ?, rooms = ?, size = ?, amenities = ? 
                WHERE id = ?`;
                
    connection.query(sql, [title, category, price, location, rooms, size, amenities, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Listing Updated Successfully' });
        } else {
            res.status(404).json({ message: 'Listing not found' });
        }
    });
};

// 5. DELETE LISTING
exports.deleteUser = (req, res) => {
    const { id } = req.body;
    connection.query('DELETE FROM listings WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0)
            res.json({ success: true, message: 'Listing Deleted Successfully' });
        else
            res.status(404).json({ message: 'Listing not found' });
    });
}; 

// 6. UPDATE USER PROFILE
exports.updateProfile = (req, res) => {
    const { name, address, contact, role, email } = req.body;
    const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ? WHERE email = ?`;
    
    connection.query(sql, [name, address, contact, role, email], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'Profile updated successfully' });
        } else {
            res.status(404).json({ success: false, message: 'User not found' });
        }
    });
};
