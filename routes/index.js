const express = require('express');
const router = express.Router();
const userController = require('../controllers/userController');

router.get('/view', userControllers.getAllUsers);
router.get('/view/:id', userControllers.getUserById);
router.post('/add', userControllers.createUser);
router.put('/update', userControllers.updateUser);
router.delete('/delete', userControllers.deleteUser);
router.post('/update-profile', userControllers.updateProfile);

module.exports = router;
