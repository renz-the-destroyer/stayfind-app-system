const express = require('express');
const router = express.Router(); // Added 'const' here
const userController = require('../controllers/userController');

// All your routes below stay the same...
router.get('/view', userController.getAllUsers);
router.get('/view/:id', userController.getUserById);
router.post('/add', userController.createUser);
router.put('/update', userController.updateUser);
router.delete('/delete', userController.deleteUser);
router.post('/update-profile', userController.updateProfile);

module.exports = router;
