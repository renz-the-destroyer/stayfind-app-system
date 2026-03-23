const express = require ('express');
router = express.Router();
const userController = require('../controllers/userController');
//route to get all users
router.get('/view', userController.getAllUsers);
//Route to search ID
router.get('/view/:id', userController.getUserById);
//Route to create new user 
router.post('/add', userController.createUser);
// update
router.put('/update/:id', userController.updateUser);
//router delete user
router.delete('/delete/:id', userController.deleteUser);

module.exports=router;