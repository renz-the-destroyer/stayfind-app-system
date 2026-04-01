const db = require('../config/db');

// 1. GET ALL USERS (Used for Login)
exports.getAllUsers = (req, res) => {
    const sql = "SELECT * FROM users";
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 2. CREATE NEW USER (Used for Sign Up)
exports.createUser = (req, res) => {
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

// 3. UPDATE USER (Admin-style update used by index.js routes)
exports.updateUser = (req, res) => {
    const { id, full_name, email, role } = req.body;
    const sql = `UPDATE users SET full_name = ?, email = ?, role = ? WHERE id = ?`;
    db.query(sql, [full_name, email, role, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'User Updated Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 4. DELETE USER
exports.deleteUser = (req, res) => {
    const { id } = req.body;
    db.query('DELETE FROM users WHERE id = ?', [id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ success: true, message: 'User Deleted Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 5. SEARCH BY ID
exports.getUserById = (req, res) => {
    const id = req.params.id;
    db.query('SELECT * FROM users WHERE id = ?', [id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length > 0) {
            res.json(rows[0]);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

// 6. UPDATE USER PROFILE (Fixed for New Account Setup)
exports.updateProfile = (req, res) => {
    const { full_name, address, contact, role, email } = req.body;

    db.query('SELECT full_name, address, contact, updated_at FROM users WHERE email = ?', [email], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        if (results.length === 0) return res.status(404).json({ success: false, message: 'User not found' });

        const user = results[0];
        const lastUpdate = new Date(user.updated_at);
        const now = new Date();
        const diffInDays = Math.floor((now - lastUpdate) / (1000 * 60 * 60 * 24));
        const isFirstTimeSetup = (!user.address || user.address === "") || (!user.contact || user.contact === "");
        const isChangingPersonalInfo = (full_name !== user.full_name || address !== user.address || contact !== user.contact);

        if (!isFirstTimeSetup && isChangingPersonalInfo && diffInDays < 30) {
            return res.status(403).json({ 
                success: false, 
                message: `Personal information can only be changed once every 30 days. Please wait ${30 - diffInDays} more days.` 
            });
        }

        const sql = `UPDATE users SET full_name = ?, address = ?, contact = ?, role = ?, updated_at = NOW() WHERE email = ?`;
        db.query(sql, [full_name, address, contact, role, email], (err, result) => {
            if (err) return res.status(500).json({ error: err.message });
            if (result.affectedRows > 0) {
                res.json({ success: true, message: 'Profile updated successfully' });
            } else {
                res.status(404).json({ success: false, message: 'User not found' });
            }
        });
    });
};

// --- UPDATED LISTING LOGIC ---

// 7. GET ALL LISTINGS (Now includes Landlord Name and Contact)
exports.getAllListings = (req, res) => {
    const sql = `
        SELECT l.*, u.full_name AS landlord_name, u.contact AS landlord_contact, u.email AS landlord_email 
        FROM listings l 
        JOIN users u ON l.user_id = u.id 
        ORDER BY l.created_at DESC`;
        
    db.query(sql, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

// 8. ADD NEW LISTING (For home.js Publish button)
exports.addListing = (req, res) => {
    const { user_id, title, category, price, location, rooms, size, amenities, images, thumbnail } = req.body;
    
    const sql = `INSERT INTO listings (user_id, title, category, price, location, rooms, size, amenities, images, thumbnail) 
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    
    const values = [user_id, title, category, price, location, rooms, size, amenities, images, thumbnail];

    db.query(sql, values, (err, result) => {
        if (err) {
            console.error("SQL Error:", err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
        res.json({ success: true, message: 'Listing Published Successfully', id: result.insertId });
    });
};

// 9. ADD REVIEW (Ratings and Comments)
exports.addReview = (req, res) => {
    const { listing_id, user_id, user_name, comment, rating } = req.body;
    const sql = `INSERT INTO reviews (listing_id, user_id, user_name, comment, rating) VALUES (?, ?, ?, ?, ?)`;
    
    db.query(sql, [listing_id, user_id, user_name, comment, rating], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true, message: 'Review submitted!' });
    });
};

// 10. GET REVIEWS FOR A SPECIFIC LISTING
exports.getReviews = (req, res) => {
    const { listing_id } = req.params;
    const sql = `SELECT * FROM reviews WHERE listing_id = ? ORDER BY created_at DESC`;
    
    db.query(sql, [listing_id], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};
