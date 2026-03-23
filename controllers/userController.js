
const connection = require('../config/db');

//get all users
exports.getAllUsers = (req, res) => {
    connection.query('SELECT * FROM reservation', (err, rows, fields) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
};

//Search a user by Id
exports.getUserById = (req, res) => {
    const id = req.params.id;
    connection.query('SELECT * FROM reservation WHERE id = ?', [id], (err, rows, fields) => {
        if (err) return res.status(500).json({ error: err.message });
        if (rows.length > 0) {
            res.json(rows);
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

exports.createUser = (req, res) => {
    const { title, seatNum, date, name } = req.body;
    connection.query('INSERT INTO reservation (title, seatNum, date, name) VALUES (?, ?, ?, ?)', [title, seatNum, date, name], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'User Created Successfully', userId: result.insertId });
    });
};

//update
exports.updateUser = (req, res) => {
    const {id} = req.body;
    const { title, seatNum, date, name } = req.body;
    connection.query('UPDATE reservation SET title = ?, seatNum = ?, date = ?, name = ? WHERE id = ?', [title, seatNum, date, name, id], (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        if (result.affectedRows > 0) {
            res.json({ message: 'User Updated Successfully' });
        } else {
            res.status(404).json({ message: 'User not found' });
        }
    });
};

//delete
exports.deleteUser = (req, res) => {
   const {id}  = req.body;
    connection.query('DELETE FROM reservation WHERE id = ?', [id], (err, result) => {
        if (err) throw err;
        if(result.affectedRows>0)
            res.json({message:'Event Deleted Succesfully'});
        else
            res.status(404).json({message:'User not found'});
    });
};

